import { join } from "node:path";
import { nanoid } from "nanoid";
import type { PersistedTask, Task, TaskCreateRequest } from "../types.js";
import { GitManager } from "../git-manager.js";
import { Executor } from "../executor.js";
import { WorkspacePool } from "../workspace-pool.js";
import { TaskStore } from "../task-store.js";
import { TokenManager } from "../auth.js";
import { UsageLimiter } from "../usage-limiter.js";
import { Config } from "../config/config.js";
import { ProjectState, TaskEntry } from "./types.js";
import {
    TaskActiveError,
    TaskCancelError,
    TaskEditError
} from "./errors.js";
import { fireWebhook } from "./utils.js";
import {
    TaskRunnerContext,
    executeTask,
    scheduleRetry,
    prepareAndRunTask
} from "./task-runner.js";

export { TaskActiveError, TaskCancelError, TaskEditError };

export class TaskManager {
    private serverWorkspaceDir: string;
    private globalMaxConcurrentTasks: number | undefined;
    private projects: Map<string, ProjectState> = new Map();
    private gitManager: GitManager;
    private store: TaskStore;
    private tasks: Map<string, TaskEntry> = new Map();
    /** Per-project FIFO queues of taskIds waiting to run. */
    private queues: Map<string, string[]> = new Map();
    /** Per-project set of PR numbers that have a task currently running. */
    private activePrNumbers: Map<string, Set<number>> = new Map();

    constructor(config: Config) {
        this.serverWorkspaceDir = config.server.workspaceDir;
        this.globalMaxConcurrentTasks = config.server.maxConcurrentTasks;
        this.gitManager = new GitManager();
        this.store = new TaskStore(config.server.workspaceDir);

        for (const [projectId, projectConfig] of Object.entries(
            config.projects
        )) {
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
            const usageLimiter = config.server.maxTokensPerHour
                ? new UsageLimiter(config.server.maxTokensPerHour, tokenManager)
                : null;
            this.projects.set(projectId, {
                config: projectConfig,
                pool,
                tokenManager,
                usageLimiter
            });
        }

        if (process.env.WORKSPACE_VOLUME) {
            console.log(
                `Docker volume mode: sandbox containers mount volume "${process.env.WORKSPACE_VOLUME}"`
            );
        } else if (process.env.WORKSPACE_HOST_DIR) {
            console.log(
                `Docker bind mode: mapping ${config.server.workspaceDir} → ${process.env.WORKSPACE_HOST_DIR} for sandbox mounts`
            );
        }
    }

    /** Build a context object exposing the internal state and callbacks needed by task-runner functions. */
    private get ctx(): TaskRunnerContext {
        return {
            tasks: this.tasks,
            queues: this.queues,
            gitManager: this.gitManager,
            store: this.store,
            serverWorkspaceDir: this.serverWorkspaceDir,
            isPrActive: (pid, pr) => this.isPrActive(pid, pr),
            markPrActive: (pid, pr) => this.markPrActive(pid, pr),
            unmarkPrActive: (pid, pr) => this.unmarkPrActive(pid, pr),
            shouldQueue: (pid, s) => this.shouldQueue(pid, s),
            enqueue: (pid, tid) => this.enqueue(pid, tid),
            tryDequeue: (pid, s) => this.tryDequeue(pid, s),
            scheduleRetry: (task, state, delay) =>
                this.scheduleRetry(task, state, delay)
        };
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

        // Resume interrupted tasks
        await this.resumeInterruptedTasks();

        // Try to start any queued tasks (capacity may be available after resumption)
        for (const [projectId, state] of this.projects) {
            this.tryDequeue(projectId, state);
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
                entry.task.status = "failed";
                entry.task.error = `Unknown project: ${entry.task.projectId}`;
                entry.task.completedAt = new Date().toISOString();
                this.store.save({
                    ...entry.task,
                    workspaceId: entry.workspaceId
                });
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

                // Mark PR as active before resuming so tryDequeue respects the serial constraint
                if (entry.task.pullRequestNumber !== undefined) {
                    this.markPrActive(
                        entry.task.projectId,
                        entry.task.pullRequestNumber
                    );
                }

                const persistedTask: PersistedTask = {
                    ...entry.task,
                    workspaceId: entry.workspaceId
                };
                this.store.save(persistedTask);

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
                    this.ctx,
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
                entry.task.status = "failed";
                entry.task.error = `Resumption failed: ${err instanceof Error ? err.message : String(err)}`;
                entry.task.completedAt = new Date().toISOString();
                const persistedTask: PersistedTask = {
                    ...entry.task,
                    workspaceId: entry.workspaceId
                };
                this.store.save(persistedTask);
            }
        }
    }

    getTask(projectId: string, taskId: string): Task | undefined {
        const entry = this.tasks.get(taskId);
        if (!entry || entry.task.projectId !== projectId) return undefined;
        return entry.task;
    }

    listTasks(projectId: string): Task[] {
        return Array.from(this.tasks.values())
            .filter((entry) => entry.task.projectId === projectId)
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

    getOutput(projectId: string, taskId: string): string {
        const entry = this.tasks.get(taskId);
        if (!entry || entry.task.projectId !== projectId) return "";
        if (entry.task.status === "running" && entry.executor) {
            return entry.executor.getOutput();
        }
        return entry.task.output;
    }

    private shouldQueue(projectId: string, state: ProjectState): boolean {
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

    private enqueue(projectId: string, taskId: string): void {
        if (!this.queues.has(projectId)) this.queues.set(projectId, []);
        this.queues.get(projectId)!.push(taskId);
    }

    private markPrActive(projectId: string, prNumber: number): void {
        if (!this.activePrNumbers.has(projectId))
            this.activePrNumbers.set(projectId, new Set());
        this.activePrNumbers.get(projectId)!.add(prNumber);
    }

    private unmarkPrActive(projectId: string, prNumber: number): void {
        this.activePrNumbers.get(projectId)?.delete(prNumber);
    }

    private isPrActive(projectId: string, prNumber: number): boolean {
        return this.activePrNumbers.get(projectId)?.has(prNumber) ?? false;
    }

    private tryDequeue(projectId: string, state: ProjectState): void {
        const queue = this.queues.get(projectId);
        if (!queue || queue.length === 0) return;
        if (this.shouldQueue(projectId, state)) return;

        // Find the first task whose PR is not currently active (or has no PR).
        const idx = queue.findIndex((tid) => {
            const e = this.tasks.get(tid);
            if (!e) return true; // stale entry — will be cleaned up below
            const prNum = e.task.pullRequestNumber;
            return prNum === undefined || !this.isPrActive(projectId, prNum);
        });

        if (idx === -1) return; // All queued tasks are waiting for their PR to free up

        const taskId = queue.splice(idx, 1)[0];
        const entry = this.tasks.get(taskId);
        if (!entry) {
            // Stale entry — try again
            this.tryDequeue(projectId, state);
            return;
        }

        const task = entry.task;

        // Mark PR as active immediately (synchronously) before any async work
        if (task.pullRequestNumber !== undefined) {
            this.markPrActive(projectId, task.pullRequestNumber);
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
                this.store.save({ ...task, workspaceId: workspace.id });
                return executeTask(
                    task,
                    workspace,
                    state,
                    this.ctx,
                    entry.checkoutBranch
                );
            })
            .catch((err) => {
                console.error(`[${taskId}] Dequeue/acquire failed:`, err);
                task.status = "failed";
                task.error = err instanceof Error ? err.message : String(err);
                task.completedAt = new Date().toISOString();
                this.store.save({ ...task, workspaceId: entry.workspaceId });
                // Release PR lock on failure
                if (task.pullRequestNumber !== undefined) {
                    this.unmarkPrActive(projectId, task.pullRequestNumber);
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
        projectId: string,
        request: TaskCreateRequest
    ): Promise<Task> {
        const state = this.projects.get(projectId);
        if (!state) throw new Error(`Unknown project: ${projectId}`);

        // Check token usage limit (OAuth only, non-fatal on API error)
        if (state.usageLimiter) {
            await state.usageLimiter.checkLimit();
        }

        const taskId = nanoid(8);

        const task: Task = {
            taskId,
            projectId,
            branch: null,
            pullRequestNumber: request.pullRequestNumber,
            prompt: request.prompt,
            status: "queued",
            startedAt: new Date().toISOString(),
            completedAt: null,
            output: "",
            callbackUrl: request.callbackUrl,
            attempt: 1
        };

        this.tasks.set(taskId, { task, executor: null, workspaceId: null });
        this.store.save({ ...task, workspaceId: null });

        // Slug generation and workspace acquisition run in the background
        prepareAndRunTask(task, state, this.ctx).catch((err) => {
            console.error(`[${taskId}] Failed to initialize task:`, err);
            task.status = "failed";
            task.error = err instanceof Error ? err.message : String(err);
            task.completedAt = new Date().toISOString();
            this.store.save({ ...task, workspaceId: null });
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
    async retryTask(projectId: string, taskId: string): Promise<Task> {
        const state = this.projects.get(projectId);
        if (!state) throw new Error(`Unknown project: ${projectId}`);

        const entry = this.tasks.get(taskId);
        if (!entry || entry.task.projectId !== projectId) {
            throw new Error(`Task not found: ${taskId}`);
        }

        const task = entry.task;

        if (
            task.status === "queued" ||
            task.status === "running" ||
            task.status === "retrying"
        ) {
            throw new TaskActiveError(task.status);
        }

        // For normal tasks: if branch was cleaned up (no commits), regenerate a slug so
        // executeTask creates a fresh branch. For PR tasks the branch is never nulled out,
        // so this only triggers for non-PR tasks.
        if (!task.branch && task.pullRequestNumber === undefined) {
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

        // If the PR is already active, queue the retry instead of running immediately
        if (
            task.pullRequestNumber !== undefined &&
            this.isPrActive(projectId, task.pullRequestNumber)
        ) {
            task.status = "queued";
            entry.executor = null;
            entry.workspaceId = null;
            entry.checkoutBranch = checkoutBranch;
            this.store.save({ ...task, workspaceId: null });
            this.enqueue(projectId, taskId);
            console.log(
                `[${taskId}] Retry queued — PR #${task.pullRequestNumber} is already active`
            );
            return task;
        }

        if (this.shouldQueue(projectId, state)) {
            task.status = "queued";
            entry.executor = null;
            entry.workspaceId = null;
            entry.checkoutBranch = checkoutBranch;
            this.store.save({ ...task, workspaceId: null });
            this.enqueue(projectId, taskId);
            console.log(`[${taskId}] Retry queued`);
            return task;
        }

        // Mark PR as active immediately before any async work
        if (task.pullRequestNumber !== undefined) {
            this.markPrActive(projectId, task.pullRequestNumber);
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
            // Unmark PR before re-queuing so tryDequeue can pick it up correctly
            if (task.pullRequestNumber !== undefined) {
                this.unmarkPrActive(projectId, task.pullRequestNumber);
            }
            task.status = "queued";
            entry.executor = null;
            entry.workspaceId = null;
            this.store.save({ ...task, workspaceId: null });
            this.enqueue(projectId, taskId);
            console.log(`[${taskId}] Retry queued after acquire race`);
            return task;
        }

        entry.workspaceId = workspace.id;
        this.store.save({ ...task, workspaceId: workspace.id });

        executeTask(task, workspace, state, this.ctx, checkoutBranch).catch(
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
    cancelTask(projectId: string, taskId: string): Task {
        const state = this.projects.get(projectId);
        if (!state) throw new Error(`Unknown project: ${projectId}`);

        const entry = this.tasks.get(taskId);
        if (!entry || entry.task.projectId !== projectId) {
            throw new Error(`Task not found: ${taskId}`);
        }

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
            task.status = "cancelled";
            task.completedAt = new Date().toISOString();
            this.store.save({ ...task, workspaceId: entry.workspaceId });
            console.log(`[${taskId}] Cancelled (was queued)`);
        } else if (previousStatus === "retrying") {
            // Clear the pending retry timer
            if (entry.retryTimeoutId !== undefined) {
                clearTimeout(entry.retryTimeoutId);
                entry.retryTimeoutId = undefined;
            }
            task.status = "cancelled";
            task.completedAt = new Date().toISOString();
            this.store.save({ ...task, workspaceId: entry.workspaceId });
            console.log(`[${taskId}] Cancelled (was retrying)`);
        } else {
            // running: set cancelled flag, kill executor — executeTask's finally block will clean up
            entry.cancelled = true;
            task.status = "cancelled";
            task.completedAt = new Date().toISOString();
            this.store.save({ ...task, workspaceId: entry.workspaceId });
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
    editTask(projectId: string, taskId: string, newPrompt: string): Task {
        const state = this.projects.get(projectId);
        if (!state) throw new Error(`Unknown project: ${projectId}`);

        const entry = this.tasks.get(taskId);
        if (!entry || entry.task.projectId !== projectId) {
            throw new Error(`Task not found: ${taskId}`);
        }

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

        this.store.save({ ...task, workspaceId: entry.workspaceId });
        console.log(`[${taskId}] Prompt updated`);

        return task;
    }

    /** Schedule a retry for a failed task. Thin wrapper used by tests and internal callers. */
    scheduleRetry(
        task: Task,
        state: ProjectState,
        delayOverrideSeconds?: number
    ): void {
        scheduleRetry(task, state, this.ctx, delayOverrideSeconds);
    }
}
