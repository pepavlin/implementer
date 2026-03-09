import { Project } from "../config/project";
import { Executor } from "../executor";
import { Branch, PersistedTask, TaskData, TaskId } from "../types";
import { WorkspaceId } from "../workspace-pool";
import { TaskManager } from "./task-manager";
import { TaskActiveError } from "./errors";
import { executeTask, generateMetadata } from "./task-runner";

export class Task {
    data: TaskData;

    // Generated metadata
    title?: string;
    branch?: Branch;

    id: TaskId;
    manager: TaskManager;
    project: Project;

    executor?: Executor;
    workspace?: { id: WorkspaceId; dir: string };
    cancelledAt?: string;

    /** Promise tracking the full run lifecycle (metadata + workspace + executeTask).
     *  Used by cancel() to wait for cleanup. */
    private runPromise?: Promise<void>;

    constructor(data: PersistedTask, manager: TaskManager) {
        this.data = data;
        this.branch = data.branch;
        this.title = data.title;
        this.id = data.taskId;
        this.manager = manager;
        this.project = manager.requireProject(data.projectId);
    }

    /** Whether this task has been cancelled. Checked by executeTask to avoid overwriting status. */
    get cancelled(): boolean {
        return this.cancelledAt !== undefined;
    }

    initialize() {
        switch (this.data.status) {
            case "starting":
                // A "starting" task was interrupted mid-startup (after status was
                // persisted to disk but before execution began). Treat it like an
                // interrupted running task so it resumes correctly:
                //  - If branch metadata was already generated, increment attempt so
                //    the restarted run uses checkoutBranchAll (resume the existing
                //    branch) instead of prepareNewBranchAll (create a new branch).
                //    Without this, the fresh run with the same branch name could fail
                //    or create a duplicate branch.
                //  - Unshift to the front of the queue to restore execution priority.
                if (this.data.branch) {
                    this.data.attempt++;
                }
                this.unshift();
                break;
            case "queued":
                this.enqueue();
                break;
            case "running":
            case "interrupted":
                // Increment attempt so the task resumes on its existing branch
                // (via checkoutBranchAll) rather than attempting to create a new
                // branch (prepareNewBranchAll). Without this, a restarted task
                // with attempt=1 would call prepareNewBranchAll, which could
                // check out a stale local or remote branch with commits from
                // the interrupted run and contaminate the new execution.
                if (this.data.branch) {
                    this.data.attempt++;
                }
                this.unshift();
                break;
            // "retrying" tasks stay as-is — dequeueAvailableTasks will
            // re-queue them when their nextRetryAt has passed.
            // "waiting_for_pipeline" tasks stay as-is — the PR poller will
            // monitor their pipeline checks and complete/fail them.
        }
    }

    enqueue() {
        this.data.status = "queued";
        this.manager.queue.push(this.data.taskId);
        this.tickUpdate();
    }

    unshift() {
        this.data.status = "queued";
        this.manager.queue.unshift(this.data.taskId);
        this.tickUpdate();
    }

    private dequeue() {
        const idx = this.manager.queue.indexOf(this.data.taskId);
        if (idx !== -1) {
            this.manager.queue.splice(idx, 1);
        }
    }

    /**
     * Cancel the task. Stops any running executor and waits for executeTask
     * to finish its cleanup (release workspace, chain lock, etc.) before returning.
     * Also cancels tasks in "waiting_for_pipeline" state (passive wait, no cleanup needed).
     */
    async cancel(): Promise<void> {
        // Remove from queue if queued
        this.dequeue();

        // Set cancelled flag — executeTask checks this to preserve cancelled status
        this.cancelledAt = new Date().toISOString();
        this.data.status = "cancelled";
        this.data.nextRetryAt = undefined;

        // Kill executor to unblock any running executor.run() call
        if (this.executor) {
            this.executor.kill();
        }

        // Wait for doRun/executeTask to finish cleanup (release workspace etc.)
        // Catch any rejection — doRun might have failed, but we don't care since we're cancelling.
        if (this.runPromise) {
            await this.runPromise.catch(() => {});
        }

        // Ensure final state is persisted (doRun's finally/catch might have saved too,
        // but we need to guarantee cancelled status is on disk)
        this.tickUpdate();
    }

    isActive(): boolean {
        return ["starting", "running"].includes(this.data.status);
    }

    /** Whether this task is currently waiting for pipeline checks to pass. */
    isWaitingForPipeline(): boolean {
        return this.data.status === "waiting_for_pipeline";
    }

    /**
     * Whether this task should block other tasks in the same chain from starting.
     * Includes "waiting_for_pipeline" in addition to the active states — a task
     * waiting for its CI/CD pipeline still has an open PR on the branch and must
     * finish (pass or fail) before a sibling task can safely modify the same branch.
     */
    isChainBlocker(): boolean {
        return ["starting", "running", "waiting_for_pipeline"].includes(
            this.data.status
        );
    }

    /**
     * Retry a task from a terminal or retrying state (completed, failed, cancelled, retrying,
     * waiting_for_pipeline).
     * Increments attempt counter, resets pipeline-related state, and pushes to front of queue.
     */
    retry(): void {
        // Queued tasks are already scheduled to run — retrying them makes no sense
        // and can cause them to run twice or in unexpected order.
        if (this.data.status === "queued") {
            throw new TaskActiveError(this.data.status);
        }
        // Allow manual retry of "retrying" tasks (skips the delay)
        if (this.isActive() && this.data.status !== "retrying") {
            throw new TaskActiveError(this.data.status);
        }

        // Reset scheduling and pipeline retry state for a clean manual retry.
        // pipelineRetryAttempt is cleared so the automatic fix-retry counter
        // starts fresh — the user explicitly chose to retry, so previous pipeline
        // attempts should not count against the configured retryCount limit.
        this.data.nextRetryAt = undefined;
        this.data.pipelineRetryAttempt = undefined;
        // Clear terminal-state timestamps and error so the retried run starts clean.
        this.data.completedAt = null;
        this.data.error = undefined;
        this.data.attempt++;
        console.log(`[${this.id}] Manual retry requested`);
        this.unshift();
    }

    /**
     * Mark the task as read by a dashboard user. Sets readAt once and persists.
     * Idempotent — calling again when already read has no effect.
     */
    markRead(): void {
        if (this.data.readAt) return; // already marked
        this.data.readAt = new Date().toISOString();
        this.tickUpdate();
    }

    /** Mark the task as completed. Sets completedAt and persists. */
    complete(): void {
        this.data.status = "completed";
        if (!this.data.completedAt) {
            this.data.completedAt = new Date().toISOString();
        }
        this.tickUpdate();
    }

    /**
     * Transition the task to "waiting_for_pipeline" status.
     * The task has finished executing and a PR has been created, but we are
     * waiting for all CI/CD pipeline checks on the PR to pass before completing.
     * The workspace is already released at this point — this is a passive wait state.
     */
    waitForPipeline(): void {
        this.data.status = "waiting_for_pipeline";
        this.tickUpdate();
    }

    /**
     * Complete a task that was waiting for pipeline checks.
     * Called by the PR poller when all checks on the PR have passed.
     */
    completePipeline(): void {
        this.data.status = "completed";
        if (!this.data.completedAt) {
            this.data.completedAt = new Date().toISOString();
        }
        console.log(`[${this.id}] Pipeline checks passed — task completed.`);
        this.tickUpdate();
    }

    /**
     * Fail a task that was waiting for pipeline checks.
     * Called by the PR poller when a pipeline check has failed.
     */
    failPipeline(error: string): void {
        this.data.error = error;
        this.data.status = "failed";
        if (!this.data.completedAt) {
            this.data.completedAt = new Date().toISOString();
        }
        console.log(`[${this.id}] Pipeline check failed — task failed: ${error}`);
        this.tickUpdate();
    }
    /**
     * Mark the task as failed. If errorRetry is configured and attempts remain,
     * sets status to "retrying" with a scheduled nextRetryAt. Otherwise sets "failed".
     */
    fail(error: string): void {
        this.data.error = error;

        const errorRetry = this.project.data.errorRetry;
        if (errorRetry && this.data.attempt < errorRetry.maxAttempts) {
            this.data.status = "retrying";
            this.data.nextRetryAt = new Date(
                Date.now() + errorRetry.delaySeconds * 1000
            ).toISOString();
            console.log(
                `[${this.id}] Will retry (attempt ${this.data.attempt}/${errorRetry.maxAttempts}) at ${this.data.nextRetryAt}`
            );
        } else {
            this.data.status = "failed";
            if (!this.data.completedAt) {
                this.data.completedAt = new Date().toISOString();
            }
        }
        this.dequeue();
        this.tickUpdate();
    }

    canBeStarted(): boolean {
        let totalActive = 0;
        let inProject = 0;
        for (const task of this.manager.tasks.values()) {
            if (task.isActive()) {
                totalActive++;

                if (task.data.projectId === this.data.projectId) {
                    inProject++;
                }
            }
        }

        if (totalActive >= this.manager.config.server.maxConcurrentTasks)
            return false;

        if (
            this.project.data.maxConcurrentTasks &&
            inProject >= this.project.data.maxConcurrentTasks
        )
            return false;

        if (
            this.manager.isChainActive(
                this.data.projectId,
                this.data.chainId,
                this.id
            )
        )
            return false;

        // Check project capacity
        if (!this.project.pool.hasFreeSlot()) return false;
        return true;
    }

    run() {
        // Set runPromise immediately so cancel() can always await the full lifecycle
        this.runPromise = this.doRun();
    }

    private async doRun() {
        if (!this.canBeStarted()) return;

        this.dequeue();

        this.data.status = "starting";
        this.data.startedAt = new Date().toISOString();
        this.tickUpdate();

        const startingTimeoutMs =
            (this.manager.config.server.startingTimeoutSeconds ?? 300) * 1000;

        // Track whether the starting-phase timeout fired.
        // Used to suppress redundant fail() calls from the catch block when the
        // timeout already handled the failure, and to guard against the workspace
        // being used after a timeout fires mid-acquire.
        let startingTimedOut = false;
        // Holds the workspace id if acquire() completes AFTER the timeout fired,
        // so the timeout handler can release it immediately.
        let postTimeoutWorkspaceId: import("../workspace-pool.js").WorkspaceId | undefined;

        const startingTimeoutId = setTimeout(() => {
            if (this.cancelled || startingTimedOut) return;
            startingTimedOut = true;
            const msg = `Task stuck in starting state for more than ${startingTimeoutMs / 1000}s — failing and re-queuing`;
            console.warn(`[${this.id}] ${msg}`);
            // fail() will set status to "retrying" (if errorRetry is configured) or
            // "failed", and call tickUpdate() → dequeueAvailableTasks().
            this.fail(msg);
            // If acquire() was already in-flight and completes after this timeout,
            // the resolved workspace id will be stored in postTimeoutWorkspaceId and
            // released below.
            if (postTimeoutWorkspaceId !== undefined) {
                this.project.pool.release(postTimeoutWorkspaceId);
                postTimeoutWorkspaceId = undefined;
            }
        }, startingTimeoutMs);

        try {
            if (this.cancelled) {
                clearTimeout(startingTimeoutId);
                return;
            }

            // Generate metadata (branch, title, duration estimate)
            if (
                !this.branch ||
                !this.title ||
                !this.data.estimatedDurationSeconds
            ) {
                const metadata = await generateMetadata(this);
                this.title = this.title ?? metadata.title;
                this.branch = this.branch ?? {
                    name: metadata.branchName,
                    createdAt: new Date().toISOString()
                };
                this.data.estimatedDurationSeconds =
                    this.data.estimatedDurationSeconds ??
                    metadata.estimatedDurationSeconds;
                this.tickUpdate();
            }

            if (this.cancelled || startingTimedOut) {
                clearTimeout(startingTimeoutId);
                return;
            }

            this.executor = new Executor(
                this.project.data.claudeCode,
                this.project.tokenManager,
                this.manager.config.server
            );

            const acquired = await this.project.pool.acquire(
                this.project.data.repositories,
                this.project.data.auth?.githubToken
            );

            // If the timeout fired while acquire() was in-flight, release the
            // workspace immediately and bail out — the task is already failed/retrying.
            if (startingTimedOut) {
                this.project.pool.release(acquired.id);
                return;
            }
            // Store the workspace; also set postTimeoutWorkspaceId so the timeout
            // handler can release it in the unlikely race where the timer fires
            // between the acquire resolve and the startingTimedOut check above.
            this.workspace = acquired;
            postTimeoutWorkspaceId = acquired.id;

            if (this.cancelled) {
                clearTimeout(startingTimeoutId);
                this.project.pool.release(this.workspace.id);
                return;
            }

            // Clear postTimeoutWorkspaceId now that we've confirmed we own the
            // workspace and will manage its lifecycle via executeTask's finally block.
            clearTimeout(startingTimeoutId);
            postTimeoutWorkspaceId = undefined;

            this.data.status = "running";
            this.tickUpdate();

            await executeTask(this);
        } catch (err) {
            clearTimeout(startingTimeoutId);
            // If the starting timeout already called fail(), don't call it again.
            if (!this.cancelled && !startingTimedOut) {
                const msg = err instanceof Error ? err.message : String(err);
                this.fail(msg);
                console.error(`[${this.id}] Run failed:`, msg);
            }
        }
    }

    tickUpdate() {
        this.manager.store.save({
            ...this.data,
            branch: this.branch,
            title: this.title,
            workspaceId: this.workspace?.id
        });

        this.manager.dequeueAvailableTasks();
    }
}
