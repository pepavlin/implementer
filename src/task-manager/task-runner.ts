import { Executor, extractLastAssistantMessage } from "../executor.js";
import { chownRecursive } from "../workspace-pool.js";
import type { Task } from "../types.js";
import type { ProjectState, TaskEntry } from "./types.js";
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
    if (!task.branch) {
        throw new Error(
            `Cannot execute task ${task.taskId}: branch is not set`
        );
    }

    const repos = state.config.repositories;
    const entry = tm.tasks.get(task.taskId)!;
    const executor = entry.executor!;
    const branchName = task.branch;
    const githubToken = state.config.auth?.githubToken;
    // Resumed/retried tasks check out the specified branch.
    // Chain continuation tasks (with parentTaskId) check out the inherited branch.
    // New standalone tasks create a new branch (fromBranch is undefined).
    const fromBranch =
        checkoutBranch ??
        (task.parentTaskId !== undefined ? task.branch : undefined);

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
            console.log(`[${task.taskId}] Creating new branch: ${branchName}`);
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
            console.log(`[${task.taskId}] Reverting protected path changes...`);
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
                // Success with no commits — keep the branch for future chain tasks
                console.log(
                    `[${task.taskId}] No new commits — leaving branch intact.`
                );
                task.status = "completed";
            }
        } else if (result.timedOut) {
            // Timeout: push any partial work, preserve the branch, and set to retrying
            // so the task is automatically resumed on the next server start (or manual retry).
            if (hasCommits) {
                console.log(
                    `[${task.taskId}] Timed out with partial commits — pushing work...`
                );
                await tm.gitManager.pushBranchAll(
                    workspace.dir,
                    repos,
                    branchName,
                    true,
                    githubToken
                );

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
                    `[${task.taskId}] Creating draft pull request(s) for partial work...`
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
                console.log(
                    `[${task.taskId}] Timed out with no commits — branch preserved for continuation.`
                );
            }

            // Always preserve the branch so the next attempt can continue from where we left off.
            // Increment attempt so recoverTask() knows to check out the existing branch on restart.
            task.attempt += 1;
            task.error = `Timed out after ${state.config.claudeCode.timeoutSeconds} seconds`;
            tm.push_front(task.projectId, task.taskId); // Re-enqueue at the front so it gets picked up immediately on restart
            console.log(
                `[${task.taskId}] Timed out — status set to retrying. Will resume on next server start or manual retry.`
            );
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
                // Failure with no commits — keep the branch for potential retries
                console.log(
                    `[${task.taskId}] Failed with no commits — leaving branch intact.`
                );
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
        // Preserve completedAt if already set by cancelTask.
        // Tasks in "retrying" state haven't finished — they'll resume later, so completedAt stays null.
        if (!task.completedAt && task.status !== "retrying") {
            task.completedAt = new Date().toISOString();
        }
        tm.saveTask(entry);
        // Release chain lock so the next task in the chain can be dequeued
        tm.unmarkChainActive(task.projectId, task.chainId);
        state.pool.release(workspace.id);
        // Start next queued task for this project if capacity is now available
        tm.dequeueAvailableTasks();
    }
}

export async function prepareMetadata(
    task: Task,
    state: ProjectState,
    tm: TaskManager,
    entry: TaskEntry
): Promise<void> {
    try {
        const { taskId, projectId } = task;
        const entry = tm.tasks.get(taskId)!;

        // Resolve branch and title based on task type
        if (!task.branch) {
            // Normal task: generate branch slug, title, and duration estimate
            console.log(`[${taskId}] Generating branch name, title, and duration estimate...`);
            const metaExecutor = new Executor(
                state.config.claudeCode,
                state.tokenManager
            );
            const { slug, title, estimatedDurationSeconds } = await metaExecutor.generateTaskMetadata(
                task.prompt,
                taskId
            );
            task.branch = `impl/${slug}-${taskId}`;
            if (title) task.title = title;
            task.estimatedDurationSeconds = estimatedDurationSeconds;
            console.log(
                `[${taskId}] Branch: ${task.branch}, Title: ${task.title}, Estimated: ${estimatedDurationSeconds}s`
            );
            tm.saveTask(entry);
        }
        if (!task.title) {
            // Branch already set (e.g., after restart), but title not yet generated
            console.log(`[${taskId}] Generating title and duration estimate...`);
            const metaExecutor = new Executor(
                state.config.claudeCode,
                state.tokenManager
            );
            const { title, estimatedDurationSeconds } = await metaExecutor.generateTaskMetadata(
                task.prompt,
                taskId
            );
            if (title) task.title = title;
            if (!task.estimatedDurationSeconds) {
                task.estimatedDurationSeconds = estimatedDurationSeconds;
            }
            console.log(`[${taskId}] Title: ${task.title}, Estimated: ${task.estimatedDurationSeconds}s`);
            tm.saveTask(entry);
        }
    } catch (err) {
        console.error(
            `[${task.taskId}] Failed to prepare branchless task:`,
            err
        );
        tm.finishTask(
            entry,
            "failed",
            err instanceof Error ? err.message : String(err)
        );
        if (task.callbackUrl) {
            fireWebhook(task.taskId, task.status, task.callbackUrl);
        }
    }
}
