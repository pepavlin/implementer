import { join } from "node:path";
import { nanoid } from "nanoid";
import type {
    Config,
    PersistedTask,
    ProjectConfig,
    Task,
    TaskCreateRequest
} from "./types.js";
import { GitManager } from "./git-manager.js";
import { Executor, extractLastAssistantMessage } from "./executor.js";
import { WorkspacePool, chownRecursive } from "./workspace-pool.js";
import { TaskStore } from "./task-store.js";
import { TokenManager } from "./auth.js";
import { UsageLimiter } from "./usage-limiter.js";


function buildSystemInstructions(repos: { name: string }[], protectedPaths?: string[]): string {
    const repoList = repos.map((r) => r.name).join(", ");
    const protectedRule =
        protectedPaths && protectedPaths.length > 0
            ? `\n- The following paths are PROTECTED and must NEVER be modified, created, or deleted: ${protectedPaths.join(", ")}. Do not make any changes to files matching these patterns under any circumstances.`
            : "";
    return `

IMPORTANT WORKSPACE RULES:
- Your workspace contains the following git repositories: ${repoList}. Always work INSIDE the repository directory (e.g. cd ${repos[0]?.name ?? "repo"} first). Do NOT create new git repositories or run git init.
- After making all changes, you MUST commit them using git. Stage your changes with "git add" and commit with "git commit". Write clear and descriptive commit messages using conventional commits format (e.g. "feat: add animated hero section with cat image", "fix: resolve navigation hover styles"). Each commit should be a logical unit of work with a message that explains what was done and why. Do NOT push — only commit.
- When you need to visually inspect a web application, ALWAYS start the dev server locally first (e.g. npm start, npm run dev) and use Playwright on the local URL (http://localhost:...). NEVER screenshot external/production URLs — you must test against the local code in your workspace so your changes are reflected.${protectedRule}
- At the very end of your response, write a concise 2-3 sentence summary of what you implemented or changed. Do not repeat the full details — just the key outcome.`;
}

interface ProjectState {
    config: ProjectConfig;
    pool: WorkspacePool;
    tokenManager: TokenManager;
    usageLimiter: UsageLimiter | null;
}

interface TaskEntry {
    task: Task;
    executor: Executor | null;
    workspaceId: number | null;
    /** Branch to check out when this task is dequeued (used for retried tasks). */
    checkoutBranch?: string;
}

export class TaskActiveError extends Error {
    constructor(status: string) {
        super(`Cannot retry task with status: ${status}`);
        this.name = "TaskActiveError";
    }
}

export class TaskManager {
    private serverWorkspaceDir: string;
    private globalMaxConcurrentTasks: number | undefined;
    private projects: Map<string, ProjectState> = new Map();
    private gitManager: GitManager;
    private store: TaskStore;
    private tasks: Map<string, TaskEntry> = new Map();
    /** Per-project FIFO queues of taskIds waiting to run. */
    private queues: Map<string, string[]> = new Map();

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

                const persistedTask: PersistedTask = {
                    ...entry.task,
                    workspaceId: entry.workspaceId
                };
                this.store.save(persistedTask);

                console.log(
                    `[task-manager] Resuming task ${entry.task.taskId} on workspace ${entry.workspaceId}`
                );

                // Fire in background — resume by checking out the existing branch
                this.executeTask(
                    entry.task,
                    workspace,
                    state,
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

    /**
     * Compute the Docker -v mount and -w workdir for a sandbox container.
     *
     * Three modes:
     * - Volume mode (WORKSPACE_VOLUME set): mount named volume, workdir = subpath inside it
     * - Bind mount mode (WORKSPACE_HOST_DIR set): bind mount host path
     * - Native mode (neither set): bind mount local path directly
     */
    private getDockerMount(workspaceDir: string): {
        volumeMount: string;
        workdir: string;
    } {
        const volume = process.env.WORKSPACE_VOLUME;
        if (volume) {
            const relativePath = workspaceDir.replace(
                this.serverWorkspaceDir,
                ""
            );
            return {
                volumeMount: `${volume}:/workspace`,
                workdir: `/workspace${relativePath}`
            };
        }

        const hostDir = process.env.WORKSPACE_HOST_DIR;
        if (hostDir) {
            const hostPath = workspaceDir.replace(
                this.serverWorkspaceDir,
                hostDir
            );
            return {
                volumeMount: `${hostPath}:/workspace`,
                workdir: "/workspace"
            };
        }

        return {
            volumeMount: `${workspaceDir}:/workspace`,
            workdir: "/workspace"
        };
    }

    /**
     * Build a PR body from Claude's last message and commit logs.
     */
    private buildPrBody(
        assistantMessage: string,
        commitLogs: Map<string, string>
    ): string {
        const parts: string[] = [];

        if (assistantMessage) {
            parts.push(`## Summary\n\n${assistantMessage}`);
        }

        if (commitLogs.size > 0) {
            const commitLines = Array.from(commitLogs.values()).join("\n");
            parts.push(`## Commits\n\n${commitLines}`);
        }

        return parts.join("\n\n") || "No summary available.";
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

    private tryDequeue(projectId: string, state: ProjectState): void {
        const queue = this.queues.get(projectId);
        if (!queue || queue.length === 0) return;
        if (this.shouldQueue(projectId, state)) return;

        const taskId = queue.shift()!;
        const entry = this.tasks.get(taskId);
        if (!entry) {
            // Task was somehow removed — try the next one
            this.tryDequeue(projectId, state);
            return;
        }

        const task = entry.task;
        const executor = new Executor(state.config.claudeCode, state.tokenManager);
        entry.executor = executor;
        task.status = "running";

        console.log(`[${taskId}] Dequeuing task (${queue.length} still queued for ${projectId})`);

        state.pool
            .acquire(state.config.repositories, state.config.auth?.githubToken)
            .then((workspace) => {
                entry.workspaceId = workspace.id;
                this.store.save({ ...task, workspaceId: workspace.id });
                return this.executeTask(task, workspace, state, entry.checkoutBranch);
            })
            .catch((err) => {
                console.error(`[${taskId}] Dequeue/acquire failed:`, err);
                task.status = "failed";
                task.error = err instanceof Error ? err.message : String(err);
                task.completedAt = new Date().toISOString();
                this.store.save({ ...task, workspaceId: entry.workspaceId });
                if (task.callbackUrl) {
                    this.fireWebhook(task.taskId, task.status, task.callbackUrl);
                }
            });
    }

    private scheduleRetry(task: Task, state: ProjectState): void {
        const retryConfig = state.config.errorRetry!;
        task.attempt += 1;
        task.status = "retrying";
        task.completedAt = null;

        const entry = this.tasks.get(task.taskId);
        if (entry) {
            this.store.save({ ...task, workspaceId: entry.workspaceId });
        }

        console.log(
            `[${task.taskId}] Retrying in ${retryConfig.delaySeconds}s (attempt ${task.attempt}/${retryConfig.maxAttempts})`
        );

        setTimeout(async () => {
            if (this.shouldQueue(task.projectId, state)) {
                // No capacity right now — put in queue and wait
                task.status = "queued";
                this.enqueue(task.projectId, task.taskId);
                const entry = this.tasks.get(task.taskId);
                if (entry) this.store.save({ ...task, workspaceId: entry.workspaceId });
                console.log(`[${task.taskId}] Retry queued (no capacity)`);
                return;
            }

            task.status = "running";
            task.error = undefined;

            let workspace: { id: number; dir: string };
            try {
                workspace = await state.pool.acquire(
                    state.config.repositories,
                    state.config.auth?.githubToken
                );
            } catch (err) {
                // Pool full despite check — queue it
                task.status = "queued";
                this.enqueue(task.projectId, task.taskId);
                const entry = this.tasks.get(task.taskId);
                if (entry) this.store.save({ ...task, workspaceId: entry.workspaceId });
                console.log(`[${task.taskId}] Retry queued after acquire race`);
                return;
            }

            const entry = this.tasks.get(task.taskId);
            if (entry) {
                entry.workspaceId = workspace.id;
                entry.executor = new Executor(state.config.claudeCode, state.tokenManager);
            }
            this.store.save({ ...task, workspaceId: workspace.id });

            // Retry on the same branch — Claude can see previous partial work
            this.executeTask(task, workspace, state, task.branch ?? undefined).catch((err) => {
                console.error(`[${task.taskId}] Retry execution failed:`, err);
            });
        }, retryConfig.delaySeconds * 1000);
    }

    private fireWebhook(taskId: string, status: string, url: string): void {
        fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId, status })
        }).catch((err) => {
            console.error(`[${taskId}] Webhook POST to ${url} failed:`, err instanceof Error ? err.message : String(err));
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
            branch: request.fromBranch ?? null,
            fromBranch: request.fromBranch,
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
        this.prepareAndRunTask(task, state).catch((err) => {
            console.error(`[${taskId}] Failed to initialize task:`, err);
            task.status = "failed";
            task.error = err instanceof Error ? err.message : String(err);
            task.completedAt = new Date().toISOString();
            this.store.save({ ...task, workspaceId: null });
            if (task.callbackUrl) {
                this.fireWebhook(taskId, task.status, task.callbackUrl);
            }
        });

        return task;
    }

    private async prepareAndRunTask(task: Task, state: ProjectState): Promise<void> {
        const { taskId, projectId } = task;

        // Generate branch slug and title in a single Docker call to minimise container overhead
        if (!task.branch) {
            console.log(`[${taskId}] Generating branch name and title...`);
            const metaExecutor = new Executor(state.config.claudeCode, state.tokenManager);
            const { slug, title } = await metaExecutor.generateTaskMetadata(task.prompt, taskId);
            task.branch = `impl/${slug}-${taskId}`;
            if (title) task.title = title;
            console.log(`[${taskId}] Branch: ${task.branch}, Title: ${task.title}`);
            this.store.save({ ...task, workspaceId: null });
        }

        // Queue if at capacity — task will be picked up by tryDequeue when a slot frees
        if (this.shouldQueue(projectId, state)) {
            this.enqueue(projectId, taskId);
            const queueLen = this.queues.get(projectId)!.length;
            console.log(`[${taskId}] Queued (position ${queueLen} for ${projectId})`);
            return;
        }

        // Acquire workspace and run immediately
        const executor = new Executor(state.config.claudeCode, state.tokenManager);
        const entry = this.tasks.get(taskId)!;
        entry.executor = executor;
        task.status = "running";

        let workspace: { id: number; dir: string };
        try {
            workspace = await state.pool.acquire(state.config.repositories, state.config.auth?.githubToken);
        } catch (_err) {
            // Race condition: another task grabbed the last slot — queue and wait
            task.status = "queued";
            entry.executor = null;
            this.store.save({ ...task, workspaceId: null });
            this.enqueue(projectId, taskId);
            console.log(`[${taskId}] Queued after acquire race`);
            return;
        }

        entry.workspaceId = workspace.id;
        this.store.save({ ...task, workspaceId: workspace.id });

        this.executeTask(task, workspace, state).catch((err) => {
            console.error(`Task ${taskId} failed unexpectedly:`, err);
        });
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

        if (task.status === "queued" || task.status === "running" || task.status === "retrying") {
            throw new TaskActiveError(task.status);
        }

        // If branch was cleaned up (no commits), regenerate a name so executeTask can create a fresh one
        if (!task.branch) {
            const slugExecutor = new Executor(state.config.claudeCode, state.tokenManager);
            const slug = await slugExecutor.generateBranchSlug(task.prompt, taskId);
            task.branch = `impl/${slug}-${taskId}`;
        }

        // Continue from the existing branch; if branch was just regenerated, checkoutBranch stays undefined
        // so executeTask creates it fresh rather than trying to checkout a non-existent branch.
        const checkoutBranch: string | undefined = task.branch !== null ? task.branch : undefined;

        // Reset task state
        task.status = "running";
        task.error = undefined;
        task.output = "";
        task.pullRequests = undefined;
        task.completedAt = null;
        task.startedAt = new Date().toISOString();
        task.attempt = 1;

        console.log(`[${taskId}] Manual retry requested — branch: ${task.branch}`);

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

        const executor = new Executor(state.config.claudeCode, state.tokenManager);
        entry.executor = executor;
        entry.checkoutBranch = checkoutBranch;

        let workspace: { id: number; dir: string };
        try {
            workspace = await state.pool.acquire(state.config.repositories, state.config.auth?.githubToken);
        } catch (_err) {
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

        this.executeTask(task, workspace, state, checkoutBranch).catch((err) => {
            console.error(`Task ${taskId} retry failed unexpectedly:`, err);
        });

        return task;
    }

    private async executeTask(
        task: Task,
        workspace: { id: number; dir: string },
        state: ProjectState,
        /** Override which branch to checkout. Defaults to task.fromBranch. Used for resume after restart. */
        checkoutBranch?: string
    ): Promise<void> {
        const repos = state.config.repositories;
        const entry = this.tasks.get(task.taskId)!;
        const executor = entry.executor!;
        const branchName = task.branch!;
        const githubToken = state.config.auth?.githubToken;
        const fromBranch = checkoutBranch ?? task.fromBranch;

        try {
            // Step 1: Prepare branch in all repos
            if (fromBranch) {
                console.log(
                    `[${task.taskId}] Checking out continuation branch: ${fromBranch}`
                );
                await this.gitManager.checkoutBranchAll(
                    workspace.dir,
                    repos,
                    fromBranch,
                    githubToken
                );
            } else {
                console.log(
                    `[${task.taskId}] Creating new branch: ${branchName}`
                );
                await this.gitManager.prepareNewBranchAll(
                    workspace.dir,
                    repos,
                    branchName,
                    githubToken
                );
            }

            // Step 2: Push branch to remote immediately so it's visible in GitHub
            console.log(`[${task.taskId}] Pushing branch to remote...`);
            await this.gitManager.pushBranchAll(
                workspace.dir,
                repos,
                branchName,
                false,
                githubToken
            );

            // Rechown after branch creation (new refs are owned by root)
            await chownRecursive(workspace.dir);

            // Step 3: Save pre-run HEAD hashes to detect new commits later
            const preRunHeads = await this.gitManager.getHeadAll(
                workspace.dir,
                repos
            );

            // Step 4: Run Claude Code in workspace dir
            const { volumeMount, workdir } = this.getDockerMount(workspace.dir);
            console.log(
                `[${task.taskId}] Running Claude Code in workspace ${workspace.id}...`
            );
            const systemPrompt = state.config.claudeCode.systemPrompt ?? "";
            const fullPrompt =
                task.prompt +
                buildSystemInstructions(repos, state.config.protectedPaths) +
                (systemPrompt ? `\n\n${systemPrompt}` : "");
            const result = await executor.run(
                fullPrompt,
                volumeMount,
                workdir,
                task.taskId
            );

            task.output = result.output;

            // Step 5: Check for uncommitted changes and ask Claude to commit if needed
            const hasUncommitted = await this.gitManager.hasUncommittedChanges(
                workspace.dir,
                repos
            );
            if (hasUncommitted) {
                console.log(
                    `[${task.taskId}] Uncommitted changes detected, asking Claude to commit...`
                );
                const commitPrompt = `You have uncommitted changes in the workspace. Stage all changes with "git add" and commit them with a clear conventional commit message. Do NOT push.`;
                await executor.run(
                    commitPrompt,
                    volumeMount,
                    workdir,
                    task.taskId
                );
            }

            // Step 6: Revert any changes to protected paths before creating the PR.
            // This handles both committed and uncommitted changes — enforces the hard boundary
            // regardless of what Claude did. Runs even if no changes were made (no-op then).
            const protectedPaths = state.config.protectedPaths ?? [];
            if (protectedPaths.length > 0) {
                console.log(`[${task.taskId}] Reverting protected path changes...`);
                await this.gitManager.revertProtectedPathsAll(
                    workspace.dir,
                    repos,
                    protectedPaths
                );
            }

            // Step 7: Ensure our branch points to HEAD (handles Claude switching branches)
            const hasCommits = await this.gitManager.ensureBranchAtHeadAll(
                workspace.dir,
                repos,
                branchName,
                preRunHeads
            );

            // Step 8: Rebase on latest default branch to avoid conflicts in PR
            if (hasCommits) {
                console.log(
                    `[${task.taskId}] Rebasing on latest default branch...`
                );
                const { conflicted } = await this.gitManager.rebaseOnDefaultAll(
                    workspace.dir,
                    repos,
                    branchName,
                    githubToken
                );

                if (conflicted.length > 0) {
                    // Rechown after fetch/rebase so sandbox container (UID 1000) can write git objects
                    await chownRecursive(workspace.dir);

                    const repoInstructions = conflicted
                        .map(
                            (r) =>
                                `- cd ${r.name} && git rebase origin/${r.defaultBranch} — resolve all conflicts, then git add the resolved files and git rebase --continue. Repeat until rebase completes.`
                        )
                        .join("\n");
                    console.log(
                        `[${task.taskId}] Rebase conflicts in ${conflicted.map((r) => r.name).join(", ")} — asking Claude to resolve...`
                    );
                    const rebasePrompt = `Some repositories need rebasing with conflict resolution:\n${repoInstructions}\nResolve every conflict by keeping the intent of your changes while incorporating the upstream updates. Do NOT push.`;
                    await executor.run(
                        rebasePrompt,
                        volumeMount,
                        workdir,
                        task.taskId
                    );
                }
            }

            if (result.exitCode === 0) {
                if (hasCommits) {
                    // Success with commits: force-push (rebase rewrites history) and create ready PR
                    console.log(`[${task.taskId}] Pushing branches...`);
                    await this.gitManager.pushBranchAll(
                        workspace.dir,
                        repos,
                        branchName,
                        true,
                        githubToken
                    );

                    // Build PR body from Claude's summary + commit log
                    const assistantMessage = extractLastAssistantMessage(
                        task.output
                    );
                    const commitLogs = await this.gitManager.getCommitLogAll(
                        workspace.dir,
                        repos,
                        branchName,
                        preRunHeads
                    );
                    const prBody = this.buildPrBody(
                        assistantMessage,
                        commitLogs
                    );

                    console.log(`[${task.taskId}] Creating pull request(s)...`);
                    const prTitle = task.prompt.split("\n")[0].slice(0, 120);
                    try {
                        const pullRequests =
                            await this.gitManager.createPullRequestAll(
                                workspace.dir,
                                repos,
                                branchName,
                                prTitle,
                                prBody,
                                false,
                                githubToken
                            );
                        if (pullRequests.length > 0) {
                            task.pullRequests = pullRequests;
                            console.log(
                                `[${task.taskId}] Created ${pullRequests.length} PR(s): ${pullRequests.map((pr) => pr.url).join(", ")}`
                            );

                            // Post original task prompt as a comment
                            const taskComment = `## Task\n\n${task.prompt}`;
                            await this.gitManager.commentOnPullRequestAll(
                                workspace.dir,
                                pullRequests,
                                taskComment,
                                githubToken
                            );
                        }
                    } catch (prErr) {
                        console.error(
                            `[${task.taskId}] PR creation failed:`,
                            prErr instanceof Error
                                ? prErr.message
                                : String(prErr)
                        );
                    }

                    task.status = "completed";
                    console.log(
                        `[${task.taskId}] Completed and pushed successfully.`
                    );
                } else {
                    // Success with no commits: delete remote branch and clear branch ref
                    console.log(
                        `[${task.taskId}] No new commits — cleaning up remote branch.`
                    );
                    await this.gitManager.deleteRemoteBranchAll(
                        workspace.dir,
                        repos,
                        branchName,
                        githubToken
                    );
                    task.branch = null;
                    task.status = "completed";
                }
            } else {
                if (hasCommits) {
                    // Failure with commits: force-push partial work and create draft PR
                    console.log(
                        `[${task.taskId}] Failed but has commits — pushing partial work...`
                    );
                    await this.gitManager.pushBranchAll(
                        workspace.dir,
                        repos,
                        branchName,
                        true,
                        githubToken
                    );

                    // Build PR body from Claude's summary + commit log
                    const assistantMessage = extractLastAssistantMessage(
                        task.output
                    );
                    const commitLogs = await this.gitManager.getCommitLogAll(
                        workspace.dir,
                        repos,
                        branchName,
                        preRunHeads
                    );
                    const prBody = this.buildPrBody(
                        assistantMessage,
                        commitLogs
                    );

                    console.log(
                        `[${task.taskId}] Creating draft pull request(s)...`
                    );
                    const prTitle = task.prompt.split("\n")[0].slice(0, 120);
                    try {
                        const pullRequests =
                            await this.gitManager.createPullRequestAll(
                                workspace.dir,
                                repos,
                                branchName,
                                prTitle,
                                prBody,
                                true,
                                githubToken
                            );
                        if (pullRequests.length > 0) {
                            task.pullRequests = pullRequests;
                            console.log(
                                `[${task.taskId}] Created ${pullRequests.length} draft PR(s): ${pullRequests.map((pr) => pr.url).join(", ")}`
                            );

                            // Post original task prompt as a comment
                            const taskComment = `## Task\n\n${task.prompt}`;
                            await this.gitManager.commentOnPullRequestAll(
                                workspace.dir,
                                pullRequests,
                                taskComment,
                                githubToken
                            );
                        }
                    } catch (prErr) {
                        console.error(
                            `[${task.taskId}] Draft PR creation failed:`,
                            prErr instanceof Error
                                ? prErr.message
                                : String(prErr)
                        );
                    }
                } else {
                    // Failure with no commits: delete remote branch
                    console.log(
                        `[${task.taskId}] Failed with no commits — cleaning up remote branch.`
                    );
                    await this.gitManager.deleteRemoteBranchAll(
                        workspace.dir,
                        repos,
                        branchName,
                        githubToken
                    );
                    task.branch = null;
                }

                task.status = "failed";
                task.error = `Claude Code exited with code ${result.exitCode}`;
                console.log(
                    `[${task.taskId}] Failed with exit code ${result.exitCode}.`
                );
            }
        } catch (err) {
            task.status = "failed";
            task.error = err instanceof Error ? err.message : String(err);
            task.output = executor.getOutput();
            console.error(`[${task.taskId}] Error:`, task.error);
        } finally {
            task.completedAt = new Date().toISOString();
            this.store.save({ ...task, workspaceId: workspace.id });
            state.pool.release(workspace.id);
            // Start next queued task for this project if capacity is now available
            this.tryDequeue(task.projectId, state);
        }

        // Schedule retry if task failed and retries are configured
        // (runs after finally — workspace already released back to pool)
        if (task.status === "failed") {
            const retryConfig = state.config.errorRetry;
            if (retryConfig && task.attempt < retryConfig.maxAttempts) {
                this.scheduleRetry(task, state);
                return; // webhook will fire only on terminal failure
            }
        }

        // Fire webhook on terminal completion (not retrying)
        if (task.callbackUrl) {
            this.fireWebhook(task.taskId, task.status, task.callbackUrl);
        }
    }
}
