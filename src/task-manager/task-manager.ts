import { join } from "node:path";
import { nanoid } from "nanoid";
import type {
    ChainId,
    PersistedTask,
    ProjectId,
    PullRequestState,
    Task,
    TaskCreateRequest,
    TaskId
} from "../types.js";
import { GitManager } from "../git-manager.js";
import { Executor } from "../executor.js";
import { WorkspacePool } from "../workspace-pool.js";
import { TaskStore } from "../task-store.js";
import { TokenManager } from "../auth.js";
import { Config } from "../config/config.js";
import { ProjectState, TaskEntry } from "./types.js";
import { TaskActiveError, TaskCancelError, TaskEditError } from "./errors.js";
import { BadRequestError } from "../errors.js";
import { fireWebhook } from "./utils.js";
import { executeTask, prepareMetadata } from "./task-runner.js";
import { PrPoller } from "../pr-poller.js";
export { TaskActiveError, TaskCancelError, TaskEditError };

export class TaskManager {
    // Global stuff
    serverWorkspaceDir: string;
    private globalMaxConcurrentTasks: number;

    // Projects
    private projects: Map<ProjectId, ProjectState> = new Map();

    gitManager: GitManager;
    private store: TaskStore;
    private prPoller: PrPoller;

    tasks: Map<TaskId, TaskEntry> = new Map();
    /** FIFO queue of taskIds waiting to run. */
    queue: TaskId[] = [];
    /** Set of chain IDs that have a task currently running. */
    private activeChains: Map<ProjectId, Set<ChainId>> = new Map();

    constructor(config: Config) {
        this.serverWorkspaceDir = config.server.workspaceDir;
        this.globalMaxConcurrentTasks = config.server.maxConcurrentTasks ?? 3;

        this.gitManager = new GitManager();
        this.store = new TaskStore(config.server.workspaceDir);
        this.prPoller = new PrPoller(this, config);

        // Get ready projects
        for (const [projectId, projectConfig] of Object.entries(
            config.projects
        ) as [ProjectId, (typeof config.projects)[string]][]) {
            const projectDir = join(
                config.server.workspaceDir,
                "projects",
                projectId
            );
            const pool = new WorkspacePool(
                projectDir,
                projectConfig.claudeCode.mcpServers,
                projectConfig.maxConcurrentTasks
            );
            const tokenManager = new TokenManager(
                projectConfig.auth,
                projectDir
            );

            this.projects.set(projectId, {
                config: projectConfig,
                pool,
                tokenManager
            });
        }
    }

    saveTask(entry: TaskEntry): void {
        this.store.save({ ...entry.task, workspaceId: entry.workspaceId });
    }

    private requireProject(projectId: ProjectId): ProjectState {
        const state = this.projects.get(projectId);
        if (!state) throw new Error(`Unknown project: ${projectId}`);
        return state;
    }

    finishTask(
        entry: TaskEntry,
        status: "completed" | "failed" | "cancelled",
        error?: string
    ): void {
        entry.task.status = status;
        if (error !== undefined) entry.task.error = error;
        if (!entry.task.completedAt) {
            entry.task.completedAt = new Date().toISOString();
        }
        this.saveTask(entry);
    }

    /**
     * Initialize task manager: rediscover workspaces, load persisted tasks,
     * mark running tasks as interrupted, and resume them.
     */
    async init(): Promise<void> {
        // Rediscover existing workspace directories from disk for each project
        for (const state of this.projects.values()) {
            state.pool.initFromDisk();
        }

        // Load all persisted tasks
        const persisted = this.store.loadAll();
        console.log(
            `[task-manager] Loaded ${persisted.length} persisted task(s) from disk`
        );

        for (const pt of persisted) {
            await this.recoverTask(pt);
        }

        // Try to start any queued tasks (capacity may be available after resumption)
        await this.dequeueAvailableTasks();

        // Start background PR state polling
        this.prPoller.start();
    }

    async dequeueAvailableTasks(): Promise<void> {
        for (const taskInQueue of this.queue) {
            let totalActive = 0;
            for (const chains of this.activeChains.values())
                totalActive += chains.size;
            if (totalActive >= this.globalMaxConcurrentTasks) break;
            const entry = this.tasks.get(taskInQueue);
            if (!entry) continue;
            if (!this.canTaskBeDequeued(entry)) continue;

            this.dequeue(entry.task.projectId, entry.task.taskId);
            await this.runOrContinueTaskFromEntry(entry);
        }

        this.retryAvailableFailedTasks();
    }

    async retryAvailableFailedTasks(): Promise<void> {
        for (const entry of this.tasks.values()) {
            const state = this.requireProject(entry.task.projectId);
            if (
                entry.task.status === "failed" &&
                entry.task.attempt <=
                    (state.config.errorRetry?.maxAttempts ?? 0)
            ) {
                const delaySeconds = state.config.errorRetry?.delaySeconds ?? 0;

                const retryConfig = state.config.errorRetry!;
                entry.task.attempt += 1;
                entry.task.status = "retrying";
                entry.task.nextRetryAt = new Date(
                    Date.now() + delaySeconds * 1000
                ).toISOString();
                entry.task.completedAt = null;

                console.log(
                    `[${entry.task.taskId}] Retrying in ${delaySeconds}s (attempt ${entry.task.attempt}/${retryConfig.maxAttempts})`
                );

                this.saveTask(entry);

                const timeoutId = setTimeout(() => {
                    entry.retryTimeoutId = undefined;
                    this.enqueue(entry.task.projectId, entry.task.taskId);
                    this.saveTask(entry);
                    this.dequeueAvailableTasks();
                }, delaySeconds * 1000);

                entry.retryTimeoutId = timeoutId;
            }
        }
    }

    private canTaskBeDequeued(taskEntry: TaskEntry): boolean {
        // Check if another task in chain is active
        if (
            this.isChainActive(taskEntry.task.projectId, taskEntry.task.chainId)
        )
            return false;

        // Check project capacity
        const state = this.requireProject(taskEntry.task.projectId);
        if (!state.pool.hasFreeSlot()) return false;

        return true;
    }

    private async runOrContinueTaskFromEntry(entry: TaskEntry): Promise<void> {
        const task = entry.task;
        const projectId = task.projectId;
        const state = this.requireProject(projectId);

        // Update status to starting
        task.status = "starting";
        this.saveTask(entry);

        // Mark chain as active immediately (synchronously) before any async work
        this.markChainActive(projectId, task.chainId);

        // If metadata not exist, generate
        if (!task.branch) {
            await prepareMetadata(task, state, this, entry);
            // prepareMetadata catches its own errors and marks the task as "failed".
            // If that happened, release the chain lock and bail out — don't acquire a workspace.
            if (task.status === "failed") {
                this.unmarkChainActive(projectId, task.chainId);
                void this.dequeueAvailableTasks();
                return;
            }
        }
        entry.executor = new Executor(
            state.config.claudeCode,
            state.tokenManager
        );

        state.pool
            .acquire(state.config.repositories, state.config.auth?.githubToken)
            .then((workspace) => {
                entry.workspaceId = workspace.id;
                task.status = "running";
                this.saveTask(entry);
                return executeTask(
                    task,
                    workspace,
                    state,
                    this,
                    entry.checkoutBranch
                );
            })
            .catch((err) => {
                console.error(`[${task.taskId}] Dequeue/acquire failed:`, err);
                this.finishTask(
                    entry,
                    "failed",
                    err instanceof Error ? err.message : String(err)
                );
                // Release chain lock on failure
                this.unmarkChainActive(projectId, task.chainId);
                if (task.callbackUrl) {
                    fireWebhook(task.taskId, task.status, task.callbackUrl);
                }
                // Status changed — attempt to dequeue waiting tasks now that the chain lock is free.
                void this.dequeueAvailableTasks();
            });
    }

    private recoverTask(pt: PersistedTask): void {
        // Continue in branch if exists
        this.tasks.set(pt.taskId, {
            task: pt,
            executor: null,
            workspaceId: pt.workspaceId,
            checkoutBranch: pt.branch ?? undefined
        });

        switch (pt.status) {
            case "starting":
            case "retrying":
            case "queued":
                this.enqueue(pt.projectId, pt.taskId);
                break;
            case "running":
                pt.status = "interrupted";
                this.saveTask(this.getTaskEntry(pt.projectId, pt.taskId));
            case "interrupted":
                this.push_front(pt.projectId, pt.taskId);
                break;
        }
    }
    getTask(projectId: ProjectId, taskId: TaskId): Task | undefined {
        const entry = this.tasks.get(taskId);
        if (!entry || entry.task.projectId !== projectId) return undefined;
        return entry.task;
    }

    getTaskEntry(projectId: ProjectId, taskId: TaskId): TaskEntry {
        const entry = this.tasks.get(taskId);
        if (!entry || entry.task.projectId !== projectId) {
            throw new Error(`Task not found: ${taskId}`);
        }
        return entry;
    }

    listTasks(projectId: ProjectId, filters?: { chainId?: ChainId }): Task[] {
        return Array.from(this.tasks.values())
            .filter((entry) => {
                if (entry.task.projectId !== projectId) return false;
                if (filters?.chainId) {
                    const cid = filters.chainId;
                    // Match tasks in the chain or the root task itself
                    // (root task's taskId serves as the chainId for children)
                    return (
                        entry.task.chainId === cid ||
                        (entry.task.taskId as string) === (cid as string)
                    );
                }
                return true;
            })
            .map((entry) => entry.task);
    }

    /**
     * Update the state of a single pull request on a task. Called by the PR
     * poller when it detects a state change. Persists the updated task to disk.
     */
    updatePrState(taskId: string, prUrl: string, state: PullRequestState): void {
        const entry = this.tasks.get(taskId as TaskId);
        if (!entry) return;
        const pr = entry.task.pullRequests?.find((p) => p.url === prUrl);
        if (!pr) return;
        pr.state = state;
        pr.lastCheckedAt = new Date().toISOString();
        this.saveTask(entry);
    }

    /** Returns all tasks across all projects, sorted by startedAt descending. */
    listAllTasks(): Task[] {
        return Array.from(this.tasks.values())
            .map((entry) => entry.task)
            .sort(
                (a, b) =>
                    new Date(b.startedAt).getTime() -
                    new Date(a.startedAt).getTime()
            );
    }

    getOutput(projectId: ProjectId, taskId: TaskId): string {
        const entry = this.tasks.get(taskId);
        if (!entry || entry.task.projectId !== projectId) return "";
        if (entry.task.status === "running" && entry.executor) {
            return entry.executor.getOutput();
        }
        return entry.task.output;
    }

    push_front(projectId: ProjectId, taskId: TaskId): void {
        const entry = this.tasks.get(taskId);
        if (!entry || entry.task.projectId !== projectId) {
            throw new Error(`Task not found: ${taskId}`);
        }
        entry.task.status = "queued";
        this.saveTask(entry);

        this.queue.unshift(taskId);
    }
    enqueue(projectId: ProjectId, taskId: TaskId): void {
        const entry = this.tasks.get(taskId);
        if (!entry || entry.task.projectId !== projectId) {
            throw new Error(`Task not found: ${taskId}`);
        }
        entry.task.status = "queued";
        this.saveTask(entry);

        this.queue.push(taskId);
    }

    dequeue(projectId: ProjectId, taskId: TaskId): void {
        const idx = this.queue.indexOf(taskId);
        if (idx !== -1) {
            this.queue.splice(idx, 1);
        }
    }

    markChainActive(projectId: ProjectId, chainId: ChainId): void {
        if (!this.activeChains.has(projectId))
            this.activeChains.set(projectId, new Set());
        this.activeChains.get(projectId)!.add(chainId);
    }

    unmarkChainActive(projectId: ProjectId, chainId: ChainId): void {
        this.activeChains.get(projectId)?.delete(chainId);
    }

    isChainActive(projectId: ProjectId, chainId: ChainId): boolean {
        return this.activeChains.get(projectId)?.has(chainId) ?? false;
    }

    /** Walk parentTaskId links to find the leaf (latest) task in a chain. */
    private findChainTip(taskId: TaskId): TaskId {
        const childIndex = new Map<TaskId, TaskId>();
        for (const [tid, entry] of this.tasks) {
            if (entry.task.parentTaskId) {
                childIndex.set(entry.task.parentTaskId, tid);
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
    async createNewTask(
        projectId: ProjectId,
        request: TaskCreateRequest
    ): Promise<Task> {
        const taskId = nanoid(8) as TaskId;

        // Resolve chain continuation fields
        let parentTaskId: TaskId | undefined;
        let chainId: ChainId | undefined;
        let inheritedBranch: string | null = null;

        if (request.continueTaskId) {
            const parentEntry = this.tasks.get(request.continueTaskId);
            if (!parentEntry || parentEntry.task.projectId !== projectId) {
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
            if (!parentEntry.task.branch) {
                throw new BadRequestError(
                    `Task ${request.continueTaskId} has no branch to continue from`
                );
            }
            parentTaskId = request.continueTaskId;
            chainId = parentEntry.task.chainId;
            inheritedBranch = parentEntry.task.branch;
        }

        const task: Task = {
            taskId,
            projectId,
            branch: inheritedBranch,
            parentTaskId,
            chainId: chainId ?? (nanoid(8) as ChainId),
            prompt: request.prompt,
            status: "creating",
            startedAt: new Date().toISOString(),
            completedAt: null,
            output: "",
            callbackUrl: request.callbackUrl,
            attempt: 1
        };

        const entry: TaskEntry = { task, executor: null, workspaceId: null };
        this.tasks.set(taskId, entry);
        this.saveTask(entry);

        this.enqueue(projectId, taskId);
        this.dequeueAvailableTasks();

        return task;
    }

    /**
     * Retry an existing task regardless of its terminal status (completed, failed, interrupted).
     * Resets the task state and re-runs it, continuing from the same branch if one exists.
     */
    async retryTask(projectId: ProjectId, taskId: TaskId): Promise<Task> {
        const state = this.requireProject(projectId);
        const entry = this.getTaskEntry(projectId, taskId);
        const task = entry.task;

        if (
            task.status === "queued" ||
            task.status === "starting" ||
            task.status === "interrupted" ||
            task.status === "creating" ||
            task.status === "running" ||
            task.status === "retrying"
        ) {
            throw new TaskActiveError(task.status);
        }

        task.attempt++;
        this.saveTask(entry);
        this.push_front(projectId, taskId);

        console.log(`[${taskId}] Manual retry requested`);

        this.dequeueAvailableTasks();

        return task;
    }

    /**
     * Immediately retry a task that is currently in "retrying" state (waiting for its
     * scheduled delay). Clears the pending retry timer and enqueues the task right away,
     * bypassing the configured delay. Throws TaskActiveError for any other status.
     */
    async retryTaskNow(projectId: ProjectId, taskId: TaskId): Promise<Task> {
        const entry = this.getTaskEntry(projectId, taskId);
        const task = entry.task;

        if (task.status !== "retrying") {
            throw new TaskActiveError(task.status);
        }

        // Clear the scheduled retry timer so it doesn't fire later
        if (entry.retryTimeoutId !== undefined) {
            clearTimeout(entry.retryTimeoutId);
            entry.retryTimeoutId = undefined;
        }

        // Clear the scheduled timestamp — the retry is happening now
        task.nextRetryAt = undefined;

        console.log(`[${taskId}] Immediate retry requested (bypassing scheduled delay)`);

        // Push to front of queue for priority execution
        this.push_front(projectId, taskId);
        this.dequeueAvailableTasks();

        return task;
    }

    /**
     * Cancel a task that is queued, running, or retrying.
     * - Queued: removed from the queue immediately, marked as cancelled.
     * - Running: executor process is killed; executeTask will detect the cancelled flag and clean up.
     * - Retrying: the pending retry timer is cleared, task is marked as cancelled.
     * Throws TaskCancelError if the task is already in a terminal state.
     */
    cancelTask(projectId: ProjectId, taskId: TaskId): Task {
        this.requireProject(projectId);
        const entry = this.getTaskEntry(projectId, taskId);
        const task = entry.task;

        if (!["queued", "starting", "running", "retrying"].includes(task.status)) {
            throw new TaskCancelError(task.status);
        }

        const previousStatus = task.status;

        if (previousStatus === "queued" || previousStatus === "starting") {
            // Remove from the project's queue
            const queue = this.queue;
            if (queue) {
                const idx = queue.indexOf(taskId);
                if (idx !== -1) queue.splice(idx, 1);
            }
            // Set cancelled flag so background prepareMetadata flow detects it
            entry.cancelled = true;
            this.finishTask(entry, "cancelled");
            // Release chain lock (was marked active when task transitioned to starting)
            this.unmarkChainActive(task.projectId, task.chainId);
            console.log(`[${taskId}] Cancelled (was ${previousStatus})`);
        } else if (previousStatus === "retrying") {
            // Clear the pending retry timer
            if (entry.retryTimeoutId !== undefined) {
                clearTimeout(entry.retryTimeoutId);
                entry.retryTimeoutId = undefined;
            }
            this.finishTask(entry, "cancelled");
            console.log(`[${taskId}] Cancelled (was retrying)`);
        } else {
            // running: set cancelled flag, kill executor — executeTask's finally block will clean up
            entry.cancelled = true;
            this.finishTask(entry, "cancelled");
            if (entry.executor) {
                entry.executor.kill();
            }
            console.log(`[${taskId}] Cancellation requested (was running)`);
        }

        if (task.callbackUrl) {
            fireWebhook(taskId, task.status, task.callbackUrl);
        }

        // After any status change, attempt to dequeue waiting tasks.
        // For "running" cancellations the executeTask finally block will call this again
        // once the workspace is actually released; this early call is a safe no-op then.
        void this.dequeueAvailableTasks();

        return task;
    }
}
