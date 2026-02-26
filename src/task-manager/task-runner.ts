import { Executor, extractLastAssistantMessage } from "../executor.js";
import { chownRecursive } from "../workspace-pool.js";
import type { ProjectId, Task } from "../types.js";
import type { GitManager } from "../git-manager.js";
import type { TaskStore } from "../task-store.js";
import type { ProjectState, TaskEntry } from "./types.js";
import {
    buildSystemInstructions,
    buildPrBody,
    getDockerMount,
    fireWebhook
} from "./utils.js";

export interface TaskRunnerContext {
    tasks: Map<string, TaskEntry>;
    queues: Map<ProjectId, string[]>;
    gitManager: GitManager;
    store: TaskStore;
    serverWorkspaceDir: string;
    isPrActive(projectId: ProjectId, prNumber: number): boolean;
    markPrActive(projectId: ProjectId, prNumber: number): void;
    unmarkPrActive(projectId: ProjectId, prNumber: number): void;
    shouldQueue(projectId: ProjectId, state: ProjectState): boolean;
    enqueue(projectId: ProjectId, taskId: string): void;
    tryDequeue(projectId: ProjectId, state: ProjectState): void;
    scheduleRetry(task: Task, state: ProjectState, delayOverrideSeconds?: number): void;
}

export async function executeTask(
    task: Task,
    workspace: { id: number; dir: string },
    state: ProjectState,
    ctx: TaskRunnerContext,
    /** Override which branch to checkout. Used for resume/retry. For PR tasks defaults to task.branch. */
    checkoutBranch?: string
): Promise<void> {
    const repos = state.config.repositories;
    const entry = ctx.tasks.get(task.taskId)!;
    const executor = entry.executor!;
    const branchName = task.branch!;
    const githubToken = state.config.auth?.githubToken;
    // PR tasks always check out their existing branch; normal tasks create a new one.
    const fromBranch =
        checkoutBranch ??
        (task.pullRequestNumber !== undefined ? task.branch! : undefined);

    try {
        // Step 1: Prepare branch in all repos
        if (fromBranch) {
            console.log(
                `[${task.taskId}] Checking out continuation branch: ${fromBranch}`
            );
            await ctx.gitManager.checkoutBranchAll(
                workspace.dir,
                repos,
                fromBranch,
                githubToken
            );
        } else {
            console.log(
                `[${task.taskId}] Creating new branch: ${branchName}`
            );
            await ctx.gitManager.prepareNewBranchAll(
                workspace.dir,
                repos,
                branchName,
                githubToken
            );
        }

        // Step 2: Push branch to remote immediately so it's visible in GitHub
        console.log(`[${task.taskId}] Pushing branch to remote...`);
        await ctx.gitManager.pushBranchAll(
            workspace.dir,
            repos,
            branchName,
            false,
            githubToken
        );

        // Rechown after branch creation (new refs are owned by root)
        await chownRecursive(workspace.dir);

        // Step 3: Save pre-run HEAD hashes to detect new commits later
        const preRunHeads = await ctx.gitManager.getHeadAll(
            workspace.dir,
            repos
        );

        // Step 4: Run Claude Code in workspace dir
        const { volumeMount, workdir } = getDockerMount(
            workspace.dir,
            ctx.serverWorkspaceDir
        );
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
        const hasUncommitted = await ctx.gitManager.hasUncommittedChanges(
            workspace.dir,
            repos
        );
        if (hasUncommitted) {
            console.log(
                `[${task.taskId}] Uncommitted changes detected, asking Claude to commit...`
            );
            const commitPrompt = `You have uncommitted changes in the workspace. Stage all changes with "git add" and commit them with a clear conventional commit message. Do NOT push.`;
            await executor.run(commitPrompt, volumeMount, workdir, task.taskId);
        }

        // Step 6: Revert any changes to protected paths before creating the PR.
        // This handles both committed and uncommitted changes — enforces the hard boundary
        // regardless of what Claude did. Runs even if no changes were made (no-op then).
        const protectedPaths = state.config.protectedPaths ?? [];
        if (protectedPaths.length > 0) {
            console.log(
                `[${task.taskId}] Reverting protected path changes...`
            );
            await ctx.gitManager.revertProtectedPathsAll(
                workspace.dir,
                repos,
                protectedPaths
            );
        }

        // Step 7: Ensure our branch points to HEAD (handles Claude switching branches)
        const hasCommits = await ctx.gitManager.ensureBranchAtHeadAll(
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
            const { conflicted } = await ctx.gitManager.rebaseOnDefaultAll(
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

        // If the task was cancelled while running, respect that status
        if (ctx.tasks.get(task.taskId)?.cancelled) {
            task.status = "cancelled";
            console.log(`[${task.taskId}] Task was cancelled.`);
            return;
        }

        if (result.exitCode === 0) {
            if (hasCommits) {
                // Success with commits: force-push (rebase rewrites history) and create ready PR
                console.log(`[${task.taskId}] Pushing branches...`);
                await ctx.gitManager.pushBranchAll(
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
                const commitLogs = await ctx.gitManager.getCommitLogAll(
                    workspace.dir,
                    repos,
                    branchName,
                    preRunHeads
                );
                const prBody = buildPrBody(assistantMessage, commitLogs);

                console.log(`[${task.taskId}] Creating pull request(s)...`);
                const prTitle = task.prompt.split("\n")[0].slice(0, 120);
                try {
                    const pullRequests =
                        await ctx.gitManager.createPullRequestAll(
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
                        await ctx.gitManager.commentOnPullRequestAll(
                            workspace.dir,
                            pullRequests,
                            taskComment,
                            githubToken
                        );
                    }
                } catch (prErr) {
                    console.error(
                        `[${task.taskId}] PR creation failed:`,
                        prErr instanceof Error ? prErr.message : String(prErr)
                    );
                }

                task.status = "completed";
                console.log(
                    `[${task.taskId}] Completed and pushed successfully.`
                );
            } else {
                // Success with no commits
                if (task.pullRequestNumber !== undefined) {
                    // PR task: keep the branch — the PR already exists on GitHub
                    console.log(
                        `[${task.taskId}] No new commits on PR branch — leaving branch intact.`
                    );
                } else {
                    // Normal task: delete remote branch and clear branch ref
                    console.log(
                        `[${task.taskId}] No new commits — cleaning up remote branch.`
                    );
                    await ctx.gitManager.deleteRemoteBranchAll(
                        workspace.dir,
                        repos,
                        branchName,
                        githubToken
                    );
                    task.branch = null;
                }
                task.status = "completed";
            }
        } else {
            if (hasCommits) {
                // Failure with commits: force-push partial work and create draft PR
                console.log(
                    `[${task.taskId}] Failed but has commits — pushing partial work...`
                );
                await ctx.gitManager.pushBranchAll(
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
                const commitLogs = await ctx.gitManager.getCommitLogAll(
                    workspace.dir,
                    repos,
                    branchName,
                    preRunHeads
                );
                const prBody = buildPrBody(assistantMessage, commitLogs);

                console.log(
                    `[${task.taskId}] Creating draft pull request(s)...`
                );
                const prTitle = task.prompt.split("\n")[0].slice(0, 120);
                try {
                    const pullRequests =
                        await ctx.gitManager.createPullRequestAll(
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
                        await ctx.gitManager.commentOnPullRequestAll(
                            workspace.dir,
                            pullRequests,
                            taskComment,
                            githubToken
                        );
                    }
                } catch (prErr) {
                    console.error(
                        `[${task.taskId}] Draft PR creation failed:`,
                        prErr instanceof Error ? prErr.message : String(prErr)
                    );
                }
            } else {
                // Failure with no commits
                if (task.pullRequestNumber !== undefined) {
                    // PR task: keep the branch — the PR already exists on GitHub
                    console.log(
                        `[${task.taskId}] Failed with no commits on PR branch — leaving branch intact.`
                    );
                } else {
                    // Normal task: delete remote branch
                    console.log(
                        `[${task.taskId}] Failed with no commits — cleaning up remote branch.`
                    );
                    await ctx.gitManager.deleteRemoteBranchAll(
                        workspace.dir,
                        repos,
                        branchName,
                        githubToken
                    );
                    task.branch = null;
                }
            }

            task.status = "failed";
            task.error = `Claude Code exited with code ${result.exitCode}`;
            console.log(
                `[${task.taskId}] Failed with exit code ${result.exitCode}.`
            );
        }
    } catch (err) {
        // If cancelled, preserve the cancelled status (don't overwrite with failed)
        if (!ctx.tasks.get(task.taskId)?.cancelled) {
            task.status = "failed";
            task.error = err instanceof Error ? err.message : String(err);
            task.output = executor.getOutput();
            console.error(`[${task.taskId}] Error:`, task.error);
        } else {
            console.log(
                `[${task.taskId}] Task was cancelled (caught during execution).`
            );
        }
    } finally {
        // Preserve completedAt if already set by cancelTask
        if (!task.completedAt) {
            task.completedAt = new Date().toISOString();
        }
        ctx.store.save({ ...task, workspaceId: workspace.id });
        // Release PR lock so the next task for this PR can be dequeued
        if (task.pullRequestNumber !== undefined) {
            ctx.unmarkPrActive(task.projectId, task.pullRequestNumber);
        }
        state.pool.release(workspace.id);
        // Start next queued task for this project if capacity is now available
        ctx.tryDequeue(task.projectId, state);
    }

    // Schedule retry if task failed and retries are configured
    // (runs after finally — workspace already released back to pool)
    if (task.status === "failed") {
        const retryConfig = state.config.errorRetry;
        if (retryConfig && task.attempt < retryConfig.maxAttempts) {
            // Tasks resumed after a server restart skip the normal retry delay on their
            // first failure so they get back to work immediately rather than waiting the
            // full delaySeconds. Subsequent retries still use the configured delay.
            const entry = ctx.tasks.get(task.taskId);
            const wasResumedFromRestart = entry?.resumedFromRestart ?? false;
            if (entry) entry.resumedFromRestart = false;
            ctx.scheduleRetry(task, state, wasResumedFromRestart ? 0 : undefined);
            return; // webhook will fire only on terminal failure
        }
    }

    // Fire webhook on terminal completion (not retrying)
    if (task.callbackUrl) {
        fireWebhook(task.taskId, task.status, task.callbackUrl);
    }
}

export function scheduleRetry(
    task: Task,
    state: ProjectState,
    ctx: TaskRunnerContext,
    delayOverrideSeconds?: number
): void {
    const retryConfig = state.config.errorRetry!;
    const delaySeconds = delayOverrideSeconds ?? retryConfig.delaySeconds;
    task.attempt += 1;
    task.status = "retrying";
    task.completedAt = null;

    const entry = ctx.tasks.get(task.taskId);
    if (entry) {
        ctx.store.save({ ...task, workspaceId: entry.workspaceId });
    }

    console.log(
        `[${task.taskId}] Retrying in ${delaySeconds}s (attempt ${task.attempt}/${retryConfig.maxAttempts})`
    );

    const timeoutId = setTimeout(async () => {
        const entryForTimer = ctx.tasks.get(task.taskId);
        if (entryForTimer) entryForTimer.retryTimeoutId = undefined;
        // If PR is active (another task for the same PR is running), queue and wait
        if (
            task.pullRequestNumber !== undefined &&
            ctx.isPrActive(task.projectId, task.pullRequestNumber)
        ) {
            task.status = "queued";
            ctx.enqueue(task.projectId, task.taskId);
            const entry = ctx.tasks.get(task.taskId);
            if (entry)
                ctx.store.save({
                    ...task,
                    workspaceId: entry.workspaceId
                });
            console.log(
                `[${task.taskId}] Retry queued — PR #${task.pullRequestNumber} is already active`
            );
            return;
        }

        if (ctx.shouldQueue(task.projectId, state)) {
            // No capacity right now — put in queue and wait
            task.status = "queued";
            ctx.enqueue(task.projectId, task.taskId);
            const entry = ctx.tasks.get(task.taskId);
            if (entry)
                ctx.store.save({
                    ...task,
                    workspaceId: entry.workspaceId
                });
            console.log(`[${task.taskId}] Retry queued (no capacity)`);
            return;
        }

        // Mark PR as active before running
        if (task.pullRequestNumber !== undefined) {
            ctx.markPrActive(task.projectId, task.pullRequestNumber);
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
            // Pool full despite check — queue it; unmark PR first
            if (task.pullRequestNumber !== undefined) {
                ctx.unmarkPrActive(task.projectId, task.pullRequestNumber);
            }
            task.status = "queued";
            ctx.enqueue(task.projectId, task.taskId);
            const entry = ctx.tasks.get(task.taskId);
            if (entry)
                ctx.store.save({
                    ...task,
                    workspaceId: entry.workspaceId
                });
            console.log(`[${task.taskId}] Retry queued after acquire race`);
            return;
        }

        const entry = ctx.tasks.get(task.taskId);
        if (entry) {
            entry.workspaceId = workspace.id;
            entry.executor = new Executor(
                state.config.claudeCode,
                state.tokenManager
            );
        }
        ctx.store.save({ ...task, workspaceId: workspace.id });

        // Retry on the same branch — Claude can see previous partial work
        executeTask(task, workspace, state, ctx, task.branch ?? undefined).catch(
            (err) => {
                console.error(`[${task.taskId}] Retry execution failed:`, err);
            }
        );
    }, delaySeconds * 1000);

    // Store timeout ID so it can be cancelled
    const entryForTimeout = ctx.tasks.get(task.taskId);
    if (entryForTimeout) entryForTimeout.retryTimeoutId = timeoutId;
}

export async function prepareAndRunTask(
    task: Task,
    state: ProjectState,
    ctx: TaskRunnerContext
): Promise<void> {
    const { taskId, projectId } = task;

    // Resolve branch and title based on task type
    if (task.pullRequestNumber !== undefined && !task.branch) {
        // PR task: fetch the PR's head branch from GitHub
        console.log(
            `[${taskId}] Fetching branch for PR #${task.pullRequestNumber}...`
        );
        const primaryRepo = state.config.repositories[0];
        const prBranch = await ctx.gitManager.getPullRequestBranch(
            task.pullRequestNumber,
            primaryRepo,
            ctx.serverWorkspaceDir,
            state.config.auth?.githubToken
        );
        task.branch = prBranch;
        if (!task.title) {
            const metaExecutor = new Executor(
                state.config.claudeCode,
                state.tokenManager
            );
            const { title } = await metaExecutor.generateTaskMetadata(
                task.prompt,
                taskId
            );
            if (title) task.title = title;
        }
        console.log(
            `[${taskId}] Branch: ${task.branch}, Title: ${task.title}`
        );
        ctx.store.save({ ...task, workspaceId: null });
    } else if (!task.branch) {
        // Normal task: generate branch slug and title
        console.log(`[${taskId}] Generating branch name and title...`);
        const metaExecutor = new Executor(
            state.config.claudeCode,
            state.tokenManager
        );
        const { slug, title } = await metaExecutor.generateTaskMetadata(
            task.prompt,
            taskId
        );
        task.branch = `impl/${slug}-${taskId}`;
        if (title) task.title = title;
        console.log(
            `[${taskId}] Branch: ${task.branch}, Title: ${task.title}`
        );
        ctx.store.save({ ...task, workspaceId: null });
    } else if (!task.title) {
        // Branch already set (e.g., after restart), but title not yet generated
        console.log(`[${taskId}] Generating title...`);
        const metaExecutor = new Executor(
            state.config.claudeCode,
            state.tokenManager
        );
        const { title } = await metaExecutor.generateTaskMetadata(
            task.prompt,
            taskId
        );
        if (title) task.title = title;
        console.log(`[${taskId}] Title: ${task.title}`);
        ctx.store.save({ ...task, workspaceId: null });
    }

    // If the PR is already active (another task for the same PR is running), queue and wait
    if (
        task.pullRequestNumber !== undefined &&
        ctx.isPrActive(projectId, task.pullRequestNumber)
    ) {
        ctx.enqueue(projectId, taskId);
        const queueLen = ctx.queues.get(projectId)?.length ?? 0;
        console.log(
            `[${taskId}] Queued — PR #${task.pullRequestNumber} is already active (position ${queueLen} for ${projectId})`
        );
        return;
    }

    // Queue if at capacity — task will be picked up by tryDequeue when a slot frees
    if (ctx.shouldQueue(projectId, state)) {
        ctx.enqueue(projectId, taskId);
        const queueLen = ctx.queues.get(projectId)?.length ?? 0;
        console.log(
            `[${taskId}] Queued (position ${queueLen} for ${projectId})`
        );
        return;
    }

    // Mark PR as active immediately before any async work
    if (task.pullRequestNumber !== undefined) {
        ctx.markPrActive(projectId, task.pullRequestNumber);
    }

    // Acquire workspace and run immediately
    const executor = new Executor(
        state.config.claudeCode,
        state.tokenManager
    );
    const entry = ctx.tasks.get(taskId)!;
    entry.executor = executor;
    task.status = "running";

    let workspace: { id: number; dir: string };
    try {
        workspace = await state.pool.acquire(
            state.config.repositories,
            state.config.auth?.githubToken
        );
    } catch (_err) {
        // Race condition: another task grabbed the last slot — queue and wait.
        // Unmark PR so tryDequeue can re-pick it up correctly.
        if (task.pullRequestNumber !== undefined) {
            ctx.unmarkPrActive(projectId, task.pullRequestNumber);
        }
        task.status = "queued";
        entry.executor = null;
        ctx.store.save({ ...task, workspaceId: null });
        ctx.enqueue(projectId, taskId);
        console.log(`[${taskId}] Queued after acquire race`);
        return;
    }

    entry.workspaceId = workspace.id;
    ctx.store.save({ ...task, workspaceId: workspace.id });

    executeTask(task, workspace, state, ctx).catch((err) => {
        console.error(`Task ${taskId} failed unexpectedly:`, err);
    });
}
