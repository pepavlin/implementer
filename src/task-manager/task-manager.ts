import { join } from "node:path";
import { nanoid } from "nanoid";
import type { ChainId, PersistedTask, ProjectId, Task, TaskCreateRequest, TaskId } from "../types.js";
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
import {
    executeTask,
    scheduleRetry,
    prepareAndRunTask
} from "./task-runner.js";

export { TaskActiveError, TaskCancelError, TaskEditError };

export class TaskManager {
    // Global stuff
    serverWorkspaceDir: string;
    private globalMaxConcurrentTasks: number | undefined;

    // Projects
    private projects: Map<ProjectId, ProjectState> = new Map();

    gitManager: GitManager;
    private store: TaskStore;

    tasks: Map<TaskId, TaskEntry> = new Map();
    /** Per-project FIFO queues of taskIds waiting to run. */
    queues: Map<ProjectId, TaskId[]> = new Map();
    /** Per-project set of chain IDs that have a task currently running. */
    private activeChains: Map<ProjectId, Set<ChainId>> = new Map();

    constructor(config: Config) {
        this.serverWorkspaceDir = config.server.workspaceDir;
        this.globalMaxConcurrentTasks = config.server.maxConcurrentTasks;

        this.gitManager = new GitManager();
        this.store = new TaskStore(config.server.workspaceDir);

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

    persistEntry(entry: TaskEntry): void {
        this.store.save({ ...entry.task, workspaceId: entry.workspaceId });
    }

    private requireProject(projectId: ProjectId): ProjectState {
        const state = this.projects.get(projectId);
        if (!state) throw new Error(`Unknown project: ${projectId}`);
        return state;
    }

    private requireEntry(projectId: ProjectId, taskId: TaskId): TaskEntry {
        const entry = this.tasks.get(taskId);
        if (!entry || entry.task.projectId !== projectId) {
            throw new Error(`Task not found: ${taskId}`);
        }
        return entry;
    }

    private finishTask(
        entry: TaskEntry,
        status: "completed" | "failed" | "cancelled",
        error?: string
    ): void {
        entry.task.status = status;
        if (error !== undefined) entry.task.error = error;
        if (!entry.task.completedAt) {
            entry.task.completedAt = new Date().toISOString();
        }
        this.persistEntry(entry);
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
            this.recoverTask(pt);
        }

        // Resume interrupted tasks
        await this.resumeInterruptedTasks();

        // Try to start any queued tasks (capacity may be available after resumption)
        for (const [projectId, state] of this.projects) {
            this.tryDequeue(projectId, state);
        }
    }

    private recoverTask(pt: PersistedTask): void {
        // Tasks that were running when the server stopped are marked as interrupted
        // so resumeInterruptedTasks() can pick them up and re-run them.
        if (pt.status === "running") {
            pt.status = "interrupted";
            pt.output = "";
            this.store.save(pt);
            console.log(
                `[task-manager] Task ${pt.taskId} marked as interrupted (was running)`
            );
            // Tasks waiting for a retry delay — the setTimeout is gone after restart.
            // Re-queue them so the next attempt runs as soon as capacity is available.
        } else if (pt.status === "retrying") {
            pt.status = "queued";
            this.store.save(pt);
            console.log(
                `[task-manager] Task ${pt.taskId} re-enqueued (was retrying)`
            );
        }

        // Populate in-memory map (no live executor for historical tasks)
        // For re-queued retrying tasks, preserve the branch as checkoutBranch so
        // tryDequeue checks out the existing branch instead of creating a new one.
        const checkoutBranch =
            pt.status === "queued" && pt.attempt > 1
                ? (pt.branch ?? undefined)
                : undefined;

        this.tasks.set(pt.taskId, {
            task: pt,
            executor: null,
            workspaceId: pt.workspaceId,
            checkoutBranch
        });

        // Re-enqueue tasks that were waiting in the queue before restart
        if (pt.status === "queued") {
            this.enqueue(pt.projectId, pt.taskId);
            console.log(`[task-manager] Task ${pt.taskId} re-enqueued`);
        }
    }

    private async resumeInterruptedTasks(): Promise<void> {
        const interrupted = Array.from(this.tasks.values()).filter(
            (e) => e.task.status === "interrupted"
        );

        if (interrupted.length === 0) return;
        console.log(
            `[task-manager] Resuming ${interrupted.length} interrupted task(s)...`
        );

        for (const entry of interrupted) {
            const state = this.projects.get(entry.task.projectId);
            if (!state) {
                console.error(
                    `[task-manager] Unknown project "${entry.task.projectId}" for task ${entry.task.taskId} — marking as failed`
                );
                this.finishTask(
                    entry,
                    "failed",
                    `Unknown project: ${entry.task.projectId}`
                );
                continue;
            }

            try {
                const workspace = await state.pool.acquireExisting(
                    entry.workspaceId!,
                    state.config.repositories
                );
                const executor = new Executor(
                    state.config.claudeCode,
                    state.tokenManager
                );
                entry.executor = executor;
                entry.task.status = "running";
                entry.task.output = "";

                // Mark chain as active before resuming so tryDequeue respects the serial constraint
                if (entry.task.chainId !== undefined) {
                    this.markChainActive(
                        entry.task.projectId,
                        entry.task.chainId
                    );
                }

                this.persistEntry(entry);

                console.log(
                    `[task-manager] Resuming task ${entry.task.taskId} on workspace ${entry.workspaceId}`
                );

                // Mark this resumption so that a failure skips the normal retry delay
                entry.resumedFromRestart = true;

                // Fire in background — resume by checking out the existing branch
                executeTask(
                    entry.task,
                    workspace,
                    state,
                    this,
                    entry.task.branch ?? undefined
                ).catch((err) => {
                    console.error(
                        `Task ${entry.task.taskId} resumption failed:`,
                        err
                    );
                });
            } catch (err) {
                console.error(
                    `[task-manager] Failed to resume task ${entry.task.taskId}:`,
                    err
                );
                this.finishTask(
                    entry,
                    "failed",
                    `Resumption failed: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        }
    }

    getTask(projectId: ProjectId, taskId: TaskId): Task | undefined {
        const entry = this.tasks.get(taskId);
        if (!entry || entry.task.projectId !== projectId) return undefined;
        return entry.task;
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

    /** Returns all active tasks (queued, running, retrying) across all projects. */
    listAllActiveTasks(): Task[] {
        return Array.from(this.tasks.values())
            .filter(
                (entry) =>
                    entry.task.status === "queued" ||
                    entry.task.status === "running" ||
                    entry.task.status === "retrying"
            )
            .map((entry) => entry.task);
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

    shouldQueue(projectId: ProjectId, state: ProjectState): boolean {
        const runningCount = Array.from(this.tasks.values()).filter(
            (e) => e.task.status === "running"
        ).length;
        if (
            this.globalMaxConcurrentTasks !== undefined &&
            runningCount >= this.globalMaxConcurrentTasks
        ) {
            return true;
        }
        return !state.pool.hasFreeSlot();
    }

    enqueue(projectId: ProjectId, taskId: TaskId): void {
        if (!this.queues.has(projectId)) this.queues.set(projectId, []);
        this.queues.get(projectId)!.push(taskId);
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

    tryDequeue(projectId: ProjectId, state: ProjectState): void {
        const queue = this.queues.get(projectId);
        if (!queue || queue.length === 0) return;
        if (this.shouldQueue(projectId, state)) return;

        // Find the first task whose chain is not currently active.
        const idx = queue.findIndex((tid) => {
            const e = this.tasks.get(tid);
            if (!e) return true; // stale entry — will be cleaned up below
            const cid = e.task.chainId;
            return cid === undefined || !this.isChainActive(projectId, cid);
        });

        if (idx === -1) return; // All queued tasks are waiting for their chain to free up

        const taskId = queue.splice(idx, 1)[0];
        const entry = this.tasks.get(taskId);
        if (!entry) {
            // Stale entry — try again
            this.tryDequeue(projectId, state);
            return;
        }

        const task = entry.task;

        // Mark chain as active immediately (synchronously) before any async work
        if (task.chainId !== undefined) {
            this.markChainActive(projectId, task.chainId);
        }

        const executor = new Executor(
            state.config.claudeCode,
            state.tokenManager
        );
        entry.executor = executor;
        task.status = "running";

        console.log(
            `[${taskId}] Dequeuing task (${queue.length} still queued for ${projectId})`
        );

        state.pool
            .acquire(state.config.repositories, state.config.auth?.githubToken)
            .then((workspace) => {
                entry.workspaceId = workspace.id;
                this.persistEntry(entry);
                return executeTask(
                    task,
                    workspace,
                    state,
                    this,
                    entry.checkoutBranch
                );
            })
            .catch((err) => {
                console.error(`[${taskId}] Dequeue/acquire failed:`, err);
                this.finishTask(
                    entry,
                    "failed",
                    err instanceof Error ? err.message : String(err)
                );
                // Release chain lock on failure
                if (task.chainId !== undefined) {
                    this.unmarkChainActive(projectId, task.chainId);
                }
                if (task.callbackUrl) {
                    fireWebhook(task.taskId, task.status, task.callbackUrl);
                }
            });
    }

    /**
     * Start a new task for the given project. Returns immediately with a queued
     * task — branch slug generation and workspace acquisition happen in the background.
     */
    async startTask(
        projectId: ProjectId,
        request: TaskCreateRequest
    ): Promise<Task> {
        const state = this.requireProject(projectId);

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
            chainId =
                parentEntry.task.chainId ?? (parentEntry.task.taskId as unknown as ChainId);
            inheritedBranch = parentEntry.task.branch;
        }

        const task: Task = {
            taskId,
            projectId,
            branch: inheritedBranch,
            parentTaskId,
            chainId,
            prompt: request.prompt,
            status: "queued",
            startedAt: new Date().toISOString(),
            completedAt: null,
            output: "",
            callbackUrl: request.callbackUrl,
            attempt: 1
        };

        const entry: TaskEntry = { task, executor: null, workspaceId: null };
        this.tasks.set(taskId, entry);
        this.persistEntry(entry);

        // Slug generation and workspace acquisition run in the background
        prepareAndRunTask(task, state, this).catch((err) => {
            console.error(`[${taskId}] Failed to initialize task:`, err);
            this.finishTask(
                entry,
                "failed",
                err instanceof Error ? err.message : String(err)
            );
            if (task.callbackUrl) {
                fireWebhook(taskId, task.status, task.callbackUrl);
            }
        });

        return task;
    }

    /**
     * Retry an existing task regardless of its terminal status (completed, failed, interrupted).
     * Resets the task state and re-runs it, continuing from the same branch if one exists.
     */
    async retryTask(projectId: ProjectId, taskId: TaskId): Promise<Task> {
        const state = this.requireProject(projectId);
        const entry = this.requireEntry(projectId, taskId);
        const task = entry.task;

        if (
            task.status === "queued" ||
            task.status === "running" ||
            task.status === "retrying"
        ) {
            throw new TaskActiveError(task.status);
        }

        // For normal tasks: if branch was cleaned up (no commits), regenerate a slug so
        // executeTask creates a fresh branch. For chain tasks the branch is never nulled out,
        // so this only triggers for non-chain tasks.
        if (!task.branch && task.chainId === undefined) {
            const slugExecutor = new Executor(
                state.config.claudeCode,
                state.tokenManager
            );
            const slug = await slugExecutor.generateBranchSlug(
                task.prompt,
                taskId
            );
            task.branch = `impl/${slug}-${taskId}`;
        }

        // Continue from the existing branch; if branch was just regenerated, checkoutBranch stays undefined
        // so executeTask creates it fresh rather than trying to checkout a non-existent branch.
        const checkoutBranch: string | undefined =
            task.branch !== null ? task.branch : undefined;

        // Reset task state
        task.status = "running";
        task.error = undefined;
        task.output = "";
        task.pullRequests = undefined;
        task.completedAt = null;
        task.startedAt = new Date().toISOString();
        task.attempt = 1;

        console.log(
            `[${taskId}] Manual retry requested — branch: ${task.branch}`
        );

        // If the chain is already active, queue the retry instead of running immediately
        if (
            task.chainId !== undefined &&
            this.isChainActive(projectId, task.chainId)
        ) {
            task.status = "queued";
            entry.executor = null;
            entry.workspaceId = null;
            entry.checkoutBranch = checkoutBranch;
            this.persistEntry(entry);
            this.enqueue(projectId, taskId);
            console.log(
                `[${taskId}] Retry queued — chain ${task.chainId} is already active`
            );
            return task;
        }

        if (this.shouldQueue(projectId, state)) {
            task.status = "queued";
            entry.executor = null;
            entry.workspaceId = null;
            entry.checkoutBranch = checkoutBranch;
            this.persistEntry(entry);
            this.enqueue(projectId, taskId);
            console.log(`[${taskId}] Retry queued`);
            return task;
        }

        // Mark chain as active immediately before any async work
        if (task.chainId !== undefined) {
            this.markChainActive(projectId, task.chainId);
        }

        const executor = new Executor(
            state.config.claudeCode,
            state.tokenManager
        );
        entry.executor = executor;
        entry.checkoutBranch = checkoutBranch;

        let workspace: { id: number; dir: string };
        try {
            workspace = await state.pool.acquire(
                state.config.repositories,
                state.config.auth?.githubToken
            );
        } catch (_err) {
            // Unmark chain before re-queuing so tryDequeue can pick it up correctly
            if (task.chainId !== undefined) {
                this.unmarkChainActive(projectId, task.chainId);
            }
            task.status = "queued";
            entry.executor = null;
            entry.workspaceId = null;
            this.persistEntry(entry);
            this.enqueue(projectId, taskId);
            console.log(`[${taskId}] Retry queued after acquire race`);
            return task;
        }

        entry.workspaceId = workspace.id;
        this.persistEntry(entry);

        executeTask(task, workspace, state, this, checkoutBranch).catch(
            (err) => {
                console.error(`Task ${taskId} retry failed unexpectedly:`, err);
            }
        );

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
        const entry = this.requireEntry(projectId, taskId);
        const task = entry.task;

        if (
            task.status !== "queued" &&
            task.status !== "running" &&
            task.status !== "retrying"
        ) {
            throw new TaskCancelError(task.status);
        }

        const previousStatus = task.status;

        if (previousStatus === "queued") {
            // Remove from the project's queue
            const queue = this.queues.get(projectId);
            if (queue) {
                const idx = queue.indexOf(taskId);
                if (idx !== -1) queue.splice(idx, 1);
            }
            this.finishTask(entry, "cancelled");
            console.log(`[${taskId}] Cancelled (was queued)`);
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

        return task;
    }

    /**
     * Edit the prompt of a queued task.
     * Only queued tasks can be edited — running/retrying tasks are already executing.
     * The title is cleared so it can be regenerated when the task eventually runs.
     * Throws TaskEditError if the task cannot be edited.
     */
    editTask(projectId: ProjectId, taskId: TaskId, newPrompt: string): Task {
        this.requireProject(projectId);
        const entry = this.requireEntry(projectId, taskId);
        const task = entry.task;

        if (task.status !== "queued") {
            throw new TaskEditError(
                `Cannot edit task with status: ${task.status}. Only queued tasks can be edited.`
            );
        }

        if (!newPrompt || !newPrompt.trim()) {
            throw new TaskEditError("Prompt cannot be empty.");
        }

        task.prompt = newPrompt.trim();
        // Clear the title so the user sees the updated prompt and title regenerates on next run
        task.title = undefined;

        this.persistEntry(entry);
        console.log(`[${taskId}] Prompt updated`);

        return task;
    }

    /** Schedule a retry for a failed task. Thin wrapper used by tests and internal callers. */
    scheduleRetry(
        task: Task,
        state: ProjectState,
        delayOverrideSeconds?: number
    ): void {
        scheduleRetry(task, state, this, delayOverrideSeconds);
    }
}
