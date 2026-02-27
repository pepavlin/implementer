import { Executor, extractLastAssistantMessage } from "../executor.js";
import { chownRecursive } from "../workspace-pool.js";
import type { Task } from "../types.js";
import type { ProjectState } from "./types.js";
import {
    buildSystemInstructions,
    buildPrBody,
    getDockerMount,
    fireWebhook
} from "./utils.js";
import type { TaskManager } from "./task-manager.js";

export async function executeTask(
    task: Task,
    workspace: { id: number; dir: string },
    state: ProjectState,
    tm: TaskManager,
    /** Override which branch to checkout. Used for resume/retry. For chain tasks defaults to task.branch. */
    checkoutBranch?: string
): Promise<void> {
    const repos = state.config.repositories;
    const entry = tm.tasks.get(task.taskId)!;
    const executor = entry.executor!;
    const branchName = task.branch!;
    const githubToken = state.config.auth?.githubToken;
    // Chain tasks always check out their existing branch; normal tasks create a new one.
    const fromBranch =
        checkoutBranch ??
        (task.chainId !== undefined ? task.branch! : undefined);

    try {
        // Step 1: Prepare branch in all repos
        if (fromBranch) {
            console.log(
                `[${task.taskId}] Checking out continuation branch: ${fromBranch}`
            );
            await tm.gitManager.checkoutBranchAll(
                workspace.dir,
                repos,
                fromBranch,
                githubToken
            );
        } else {
            console.log(
                `[${task.taskId}] Creating new branch: ${branchName}`
            );
            await tm.gitManager.prepareNewBranchAll(
                workspace.dir,
                repos,
                branchName,
                githubToken
            );
        }

        // Step 2: Push branch to remote immediately so it's visible in GitHub
        console.log(`[${task.taskId}] Pushing branch to remote...`);
        await tm.gitManager.pushBranchAll(
            workspace.dir,
            repos,
            branchName,
            false,
            githubToken
        );

        // Rechown after branch creation (new refs are owned by root)
        await chownRecursive(workspace.dir);

        // Step 3: Save pre-run HEAD hashes to detect new commits later
        const preRunHeads = await tm.gitManager.getHeadAll(
            workspace.dir,
            repos
        );

        // Step 4: Run Claude Code in workspace dir
        const { volumeMount, workdir } = getDockerMount(
            workspace.dir,
            tm.serverWorkspaceDir
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
        const hasUncommitted = await tm.gitManager.hasUncommittedChanges(
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
            await tm.gitManager.revertProtectedPathsAll(
                workspace.dir,
                repos,
                protectedPaths
            );
        }

        // Step 7: Ensure our branch points to HEAD (handles Claude switching branches)
        const hasCommits = await tm.gitManager.ensureBranchAtHeadAll(
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
            const { conflicted } = await tm.gitManager.rebaseOnDefaultAll(
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
        if (tm.tasks.get(task.taskId)?.cancelled) {
            task.status = "cancelled";
            console.log(`[${task.taskId}] Task was cancelled.`);
            return;
        }

        if (result.exitCode === 0) {
            if (hasCommits) {
                // Success with commits: force-push (rebase rewrites history) and create ready PR
                console.log(`[${task.taskId}] Pushing branches...`);
                await tm.gitManager.pushBranchAll(
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
                const commitLogs = await tm.gitManager.getCommitLogAll(
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
                        await tm.gitManager.createPullRequestAll(
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
                        await tm.gitManager.commentOnPullRequestAll(
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
                if (task.chainId !== undefined) {
                    // Chain task: keep the branch — future chain tasks may need it
                    console.log(
                        `[${task.taskId}] No new commits on continuation branch — leaving branch intact.`
                    );
                } else {
                    // Normal task: delete remote branch and clear branch ref
                    console.log(
                        `[${task.taskId}] No new commits — cleaning up remote branch.`
                    );
                    await tm.gitManager.deleteRemoteBranchAll(
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
                await tm.gitManager.pushBranchAll(
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
                const commitLogs = await tm.gitManager.getCommitLogAll(
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
                        await tm.gitManager.createPullRequestAll(
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
                        await tm.gitManager.commentOnPullRequestAll(
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
                if (task.chainId !== undefined) {
                    // Chain task: keep the branch
                    console.log(
                        `[${task.taskId}] Failed with no commits on continuation branch — leaving branch intact.`
                    );
                } else {
                    // Normal task: delete remote branch
                    console.log(
                        `[${task.taskId}] Failed with no commits — cleaning up remote branch.`
                    );
                    await tm.gitManager.deleteRemoteBranchAll(
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
        if (!tm.tasks.get(task.taskId)?.cancelled) {
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
        tm.persistEntry(entry);
        // Release chain lock so the next task in the chain can be dequeued
        if (task.chainId !== undefined) {
            tm.unmarkChainActive(task.projectId, task.chainId);
        }
        state.pool.release(workspace.id);
        // Start next queued task for this project if capacity is now available
        tm.tryDequeue(task.projectId, state);
    }

    // Schedule retry if task failed and retries are configured
    // (runs after finally — workspace already released back to pool)
    if (task.status === "failed") {
        const retryConfig = state.config.errorRetry;
        if (retryConfig && task.attempt < retryConfig.maxAttempts) {
            // Tasks resumed after a server restart skip the normal retry delay on their
            // first failure so they get back to work immediately rather than waiting the
            // full delaySeconds. Subsequent retries still use the configured delay.
            const entry = tm.tasks.get(task.taskId);
            const wasResumedFromRestart = entry?.resumedFromRestart ?? false;
            if (entry) entry.resumedFromRestart = false;
            tm.scheduleRetry(task, state, wasResumedFromRestart ? 0 : undefined);
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
    tm: TaskManager,
    delayOverrideSeconds?: number
): void {
    const retryConfig = state.config.errorRetry!;
    const delaySeconds = delayOverrideSeconds ?? retryConfig.delaySeconds;
    task.attempt += 1;
    task.status = "retrying";
    task.completedAt = null;

    const entry = tm.tasks.get(task.taskId);
    if (entry) {
        tm.persistEntry(entry);
    }

    console.log(
        `[${task.taskId}] Retrying in ${delaySeconds}s (attempt ${task.attempt}/${retryConfig.maxAttempts})`
    );

    const timeoutId = setTimeout(async () => {
        const entryForTimer = tm.tasks.get(task.taskId);
        if (entryForTimer) entryForTimer.retryTimeoutId = undefined;
        // If chain is active (another task in the same chain is running), queue and wait
        if (
            task.chainId !== undefined &&
            tm.isChainActive(task.projectId, task.chainId)
        ) {
            task.status = "queued";
            tm.enqueue(task.projectId, task.taskId);
            const entry = tm.tasks.get(task.taskId);
            if (entry) tm.persistEntry(entry);
            console.log(
                `[${task.taskId}] Retry queued — chain ${task.chainId} is already active`
            );
            return;
        }

        if (tm.shouldQueue(task.projectId, state)) {
            // No capacity right now — put in queue and wait
            task.status = "queued";
            tm.enqueue(task.projectId, task.taskId);
            const entry = tm.tasks.get(task.taskId);
            if (entry) tm.persistEntry(entry);
            console.log(`[${task.taskId}] Retry queued (no capacity)`);
            return;
        }

        // Mark chain as active before running
        if (task.chainId !== undefined) {
            tm.markChainActive(task.projectId, task.chainId);
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
            // Pool full despite check — queue it; unmark chain first
            if (task.chainId !== undefined) {
                tm.unmarkChainActive(task.projectId, task.chainId);
            }
            task.status = "queued";
            tm.enqueue(task.projectId, task.taskId);
            const entry = tm.tasks.get(task.taskId);
            if (entry) tm.persistEntry(entry);
            console.log(`[${task.taskId}] Retry queued after acquire race`);
            return;
        }

        const entry = tm.tasks.get(task.taskId);
        if (entry) {
            entry.workspaceId = workspace.id;
            entry.executor = new Executor(
                state.config.claudeCode,
                state.tokenManager
            );
            tm.persistEntry(entry);
        }

        // Retry on the same branch — Claude can see previous partial work
        executeTask(task, workspace, state, tm, task.branch ?? undefined).catch(
            (err) => {
                console.error(`[${task.taskId}] Retry execution failed:`, err);
            }
        );
    }, delaySeconds * 1000);

    // Store timeout ID so it can be cancelled
    const entryForTimeout = tm.tasks.get(task.taskId);
    if (entryForTimeout) entryForTimeout.retryTimeoutId = timeoutId;
}

export async function prepareAndRunTask(
    task: Task,
    state: ProjectState,
    tm: TaskManager
): Promise<void> {
    const { taskId, projectId } = task;
    const entry = tm.tasks.get(taskId)!;

    // Resolve branch and title based on task type
    if (!task.branch) {
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
        tm.persistEntry(entry);
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
        tm.persistEntry(entry);
    }

    // If the chain is already active (another task in the same chain is running), queue and wait
    if (
        task.chainId !== undefined &&
        tm.isChainActive(projectId, task.chainId)
    ) {
        tm.enqueue(projectId, taskId);
        const queueLen = tm.queues.get(projectId)?.length ?? 0;
        console.log(
            `[${taskId}] Queued — chain ${task.chainId} is already active (position ${queueLen} for ${projectId})`
        );
        return;
    }

    // Queue if at capacity — task will be picked up by tryDequeue when a slot frees
    if (tm.shouldQueue(projectId, state)) {
        tm.enqueue(projectId, taskId);
        const queueLen = tm.queues.get(projectId)?.length ?? 0;
        console.log(
            `[${taskId}] Queued (position ${queueLen} for ${projectId})`
        );
        return;
    }

    // Mark chain as active immediately before any async work
    if (task.chainId !== undefined) {
        tm.markChainActive(projectId, task.chainId);
    }

    // Acquire workspace and run immediately
    const executor = new Executor(
        state.config.claudeCode,
        state.tokenManager
    );
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
        // Unmark chain so tryDequeue can re-pick it up correctly.
        if (task.chainId !== undefined) {
            tm.unmarkChainActive(projectId, task.chainId);
        }
        task.status = "queued";
        entry.executor = null;
        tm.persistEntry(entry);
        tm.enqueue(projectId, taskId);
        console.log(`[${taskId}] Queued after acquire race`);
        return;
    }

    entry.workspaceId = workspace.id;
    tm.persistEntry(entry);

    executeTask(task, workspace, state, tm).catch((err) => {
        console.error(`Task ${taskId} failed unexpectedly:`, err);
    });
}
