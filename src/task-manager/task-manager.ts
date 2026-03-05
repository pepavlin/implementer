import { nanoid } from "nanoid";
import type {
    ChainId,
    ProjectId,
    PullRequestState,
    TaskCreateRequest,
    TaskId
} from "../types.js";
import { PRIORITY_WEIGHT } from "../types.js";
import { GitManager } from "../git-manager.js";
import { TaskStore } from "../task-store.js";
import { Config } from "../config/config.js";
import { Project } from "../config/project.js";
import { TaskActiveError } from "./errors.js";
import { BadRequestError } from "../errors.js";
import { Task } from "./task.js";
import { PrPoller, type PollableTask } from "../pr-poller.js";
export { TaskActiveError };

export class TaskManager {
    config: Config;

    gitManager: GitManager;

    store: TaskStore;

    tasks: Map<TaskId, Task> = new Map();
    /** FIFO queue of taskIds waiting to run. */
    queue: TaskId[] = [];

    private _paused: boolean = false;
    /** Suppresses dequeueAvailableTasks() during bulk initialization to prevent partial-queue starts. */
    private _initializing: boolean = false;

    private prPoller: PrPoller;

    constructor(config: Config) {
        this.config = config;

        this.gitManager = new GitManager();
        this.store = new TaskStore(config.server.workspaceDir);
        this.prPoller = new PrPoller(
            {
                listAllTasks: () => this.listAllPollableTasks(),
                updatePrState: (taskId, prUrl, state) =>
                    this.updatePrState(taskId, prUrl, state)
            },
            config
        );
    }
    /**
     * Initialize task manager: rediscover workspaces, load persisted tasks,
     * mark running tasks as interrupted, and resume them.
     */
    async init(): Promise<void> {
        Object.values(this.config.projects).forEach((project) =>
            project.initialize()
        );

        // Load all persisted tasks while suppressing mid-loop dequeue so that
        // all tasks are in the queue before priority sorting happens.
        this._initializing = true;
        const persisted = this.store.loadAll();
        for (const pt of persisted) {
            const task = new Task(pt, this);
            this.tasks.set(pt.taskId, task);
            task.initialize();
        }
        this._initializing = false;
        console.log(
            `[task-manager] Loaded ${persisted.length} persisted task(s) from disk`
        );

        // Try to start any queued tasks (capacity may be available after resumption)
        this.dequeueAvailableTasks();

        // Start background PR state polling
        this.prPoller.start();
    }

    /** Returns true when the queue is globally paused (no new tasks will be started). */
    isPaused(): boolean {
        return this._paused;
    }

    /**
     * Pause queue processing. Tasks already running continue to completion,
     * but no new tasks will be dequeued until resume() is called.
     */
    pause(): void {
        this._paused = true;
        console.log("[task-manager] Queue paused — running tasks continue but no new tasks will start");
    }

    /**
     * Resume queue processing. Immediately triggers dequeueAvailableTasks
     * so queued tasks start as soon as capacity allows.
     */
    resume(): void {
        this._paused = false;
        console.log("[task-manager] Queue resumed");
        this.dequeueAvailableTasks();
    }

    dequeueAvailableTasks(): void {
        // Skip during bulk initialization — a single call is made at the end of init().
        if (this._initializing) return;

        // Promote retrying tasks whose nextRetryAt has passed back into the queue
        const now = Date.now();
        for (const task of Array.from(this.tasks.values()).sort(
            (a, b) =>
                new Date(a.data.startedAt).getTime() -
                new Date(b.data.startedAt).getTime()
        )) {
            if (
                task.data.status === "retrying" &&
                task.data.nextRetryAt &&
                new Date(task.data.nextRetryAt).getTime() <= now
            ) {
                task.data.attempt++;
                task.data.nextRetryAt = undefined;
                console.log(
                    `[${task.id}] Retry delay elapsed, re-queuing (attempt ${task.data.attempt})`
                );
                task.unshift();
            }
        }

        // When paused, do not start any new tasks
        if (this._paused) return;

        // Sort queued tasks by priority (descending) then by queue position / startedAt (FIFO)
        const sortedQueue = [...this.queue].sort((aId, bId) => {
            const a = this.tasks.get(aId);
            const b = this.tasks.get(bId);
            if (!a || !b) return 0;
            const aPriority = PRIORITY_WEIGHT[a.data.priority ?? "normal"] ?? 1;
            const bPriority = PRIORITY_WEIGHT[b.data.priority ?? "normal"] ?? 1;
            if (bPriority !== aPriority) return bPriority - aPriority; // Higher priority first
            // Same priority — respect original queue order (FIFO via startedAt)
            return new Date(a.data.startedAt).getTime() - new Date(b.data.startedAt).getTime();
        });

        // Start queued tasks that have capacity
        for (const taskId of sortedQueue) {
            const task = this.tasks.get(taskId);
            if (!task) continue;
            if (!task.canBeStarted()) continue;

            task.run();
        }
    }

    requireProject(projectId: ProjectId): Project {
        const project = this.config.projects[projectId];
        if (!project) throw new Error(`Unknown project: ${projectId}`);
        return project;
    }

    getTask(taskId: TaskId): Task | undefined {
        return this.tasks.get(taskId);
    }

    requireTask(projectId: ProjectId, taskId: TaskId): Task {
        const task = this.tasks.get(taskId);
        if (!task || task.data.projectId !== projectId) {
            throw new Error(`Task not found: ${taskId}`);
        }
        return task;
    }

    listTasks(projectId: ProjectId, filters?: { chainId?: ChainId }): Task[] {
        return Array.from(this.tasks.values()).filter((task) => {
            if (task.data.projectId !== projectId) return false;
            if (filters?.chainId) {
                const cid = filters.chainId;
                return (
                    task.data.chainId === cid ||
                    (task.id as string) === (cid as string)
                );
            }
            return true;
        });
    }

    /** Returns all tasks across all projects, sorted by startedAt descending. */
    listAllTasks(): Task[] {
        return Array.from(this.tasks.values()).sort(
            (a, b) =>
                new Date(b.data.startedAt).getTime() -
                new Date(a.data.startedAt).getTime()
        );
    }

    getOutput(taskId: TaskId): string {
        const task = this.tasks.get(taskId);
        if (!task) return "";
        if (task.isActive() && task.executor) {
            return task.executor.getOutput();
        }
        return task.data.output;
    }

    /** Returns all tasks mapped to the minimal shape needed by PrPoller. */
    private listAllPollableTasks(): PollableTask[] {
        return Array.from(this.tasks.values()).map((task) => ({
            taskId: task.id as string,
            projectId: task.data.projectId as string,
            pullRequests: task.data.pullRequests
        }));
    }

    /** Update the state of a specific PR on a task. Used by PrPoller. */
    updatePrState(
        taskId: string,
        prUrl: string,
        state: PullRequestState
    ): void {
        const task = this.tasks.get(taskId as TaskId);
        if (!task) return;
        const pr = task.data.pullRequests?.find((p) => p.url === prUrl);
        if (!pr) return;
        pr.state = state;
        pr.lastCheckedAt = new Date().toISOString();
        task.tickUpdate();
    }

    /** Walk parentTaskId links to find the leaf (latest) task in a chain. */
    private findChainTip(taskId: TaskId): TaskId {
        const childIndex = new Map<TaskId, TaskId>();
        for (const [tid, task] of this.tasks) {
            if (task.data.parentTaskId) {
                childIndex.set(task.data.parentTaskId, tid);
            }
        }
        let current = taskId;
        while (childIndex.has(current)) {
            current = childIndex.get(current)!;
        }
        return current;
    }

    /**
     * Start a new task for the given project. Returns immediately with a queued
     * task — branch slug generation and workspace acquisition happen in the background.
     */
    createNewTask(projectId: ProjectId, request: TaskCreateRequest): Task {
        this.requireProject(projectId);
        const taskId = nanoid(8) as TaskId;

        // Resolve chain continuation fields
        let parentTaskId: TaskId | undefined;
        let chainId: ChainId | undefined;
        let inheritedBranch: string | undefined;

        if (request.continueTaskId) {
            const parent = this.tasks.get(request.continueTaskId);
            if (!parent || parent.data.projectId !== projectId) {
                throw new BadRequestError(
                    `Task not found: ${request.continueTaskId}`
                );
            }
            // Validate it's the chain tip (no children)
            const tip = this.findChainTip(request.continueTaskId);
            if (tip !== request.continueTaskId) {
                throw new BadRequestError(
                    `Task ${request.continueTaskId} is not the latest in its chain. Continue from ${tip} instead.`
                );
            }
            // Validate parent has a branch
            if (!parent.branch) {
                throw new BadRequestError(
                    `Task ${request.continueTaskId} has no branch to continue from`
                );
            }
            parentTaskId = request.continueTaskId;
            chainId = parent.data.chainId;
            inheritedBranch = parent.branch.name;
        }

        const task = new Task(
            {
                taskId,
                projectId,
                branch: inheritedBranch
                    ? {
                          name: inheritedBranch,
                          createdAt: new Date().toISOString()
                      }
                    : undefined,
                parentTaskId,
                chainId: chainId ?? (nanoid(8) as ChainId),
                prompt: request.prompt,
                status: "queued",
                startedAt: new Date().toISOString(),
                completedAt: null,
                output: "",
                callbackUrl: request.callbackUrl,
                attempt: 1,
                priority: request.priority ?? "normal"
            },
            this
        );

        this.tasks.set(taskId, task);
        task.enqueue();

        return task;
    }

    /**
     * Retry an existing task. Delegates validation and state changes to Task.retry().
     */
    retryTask(projectId: ProjectId, taskId: TaskId): Task {
        const task = this.requireTask(projectId, taskId);
        task.retry();
        return task;
    }

    /**
     * Cancel a task. Delegates to Task.cancel() which handles all states
     * (queued, starting, running, retrying) and waits for cleanup.
     */
    async cancelTask(projectId: ProjectId, taskId: TaskId): Promise<Task> {
        const task = this.requireTask(projectId, taskId);
        await task.cancel();
        return task;
    }

    /**
     * Update the priority of a queued task.
     * Has no effect on tasks that are already running/completed.
     */
    setTaskPriority(taskId: TaskId, priority: import("../types.js").TaskPriority): Task {
        const task = this.tasks.get(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        task.data.priority = priority;
        task.tickUpdate();
        return task;
    }

    /**
     * Mark a task as read by a dashboard user. Idempotent.
     * Persists readAt to disk so the status is shared across devices.
     */
    markTaskRead(taskId: TaskId): Task {
        const task = this.tasks.get(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        task.markRead();
        return task;
    }

    /**
     * Check if any OTHER task in the given chain is currently active.
     * Excludes the calling task (by excludeTaskId) so a queued task
     * doesn't block itself from starting.
     */
    isChainActive(
        projectId: ProjectId,
        chainId: ChainId,
        excludeTaskId?: TaskId
    ): boolean {
        for (const task of this.tasks.values()) {
            if (
                task.data.projectId === projectId &&
                task.data.chainId === chainId &&
                task.id !== excludeTaskId &&
                task.isActive()
            ) {
                return true;
            }
        }
        return false;
    }
}
