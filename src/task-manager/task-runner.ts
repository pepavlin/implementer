import { extractLastAssistantMessage } from "../executor.js";
import { Executor } from "../executor.js";
import { chownRecursive } from "../workspace-pool.js";
import {
    buildSystemInstructions,
    buildPrBody,
    getDockerMount
} from "./utils.js";
import { Task } from "./task.js";

export async function executeTask(task: Task): Promise<void> {
    if (!task.branch) {
        throw new Error(`Cannot execute task ${task.id}: branch is not set`);
    }

    const manager = task.manager;
    const project = task.project;
    const repos = project.data.repositories;
    const executor = task.executor!;
    const branchName = task.branch.name;
    const githubToken = project.data.auth?.githubToken;
    const workspace = task.workspace!;

    // Determine whether to check out an existing branch or create a new one.
    // Chain continuation tasks (with parentTaskId) check out the inherited branch.
    // Retried tasks (attempt > 1) check out the branch from the previous attempt.
    // New standalone tasks create a new branch.
    const isExistingBranch =
        task.data.parentTaskId !== undefined || task.data.attempt > 1;

    try {
        // Early exit if cancelled before execution started
        if (task.cancelled) {
            console.log(`[${task.id}] Task was cancelled before execution.`);
            return;
        }

        // Step 1: Prepare branch in all repos
        if (isExistingBranch) {
            console.log(
                `[${task.id}] Checking out existing branch: ${branchName}`
            );
            await manager.gitManager.checkoutBranchAll(
                workspace.dir,
                repos,
                branchName,
                githubToken
            );
        } else {
            console.log(`[${task.id}] Creating new branch: ${branchName}`);
            await manager.gitManager.prepareNewBranchAll(
                workspace.dir,
                repos,
                branchName,
                githubToken
            );
        }

        // Step 2: Push branch to remote immediately so it's visible in GitHub
        console.log(`[${task.id}] Pushing branch to remote...`);
        await manager.gitManager.pushBranchAll(
            workspace.dir,
            repos,
            branchName,
            false,
            githubToken
        );

        // Rechown after branch creation (new refs are owned by root)
        await chownRecursive(workspace.dir);

        // Step 3: Save pre-run HEAD hashes to detect new commits later
        const preRunHeads = await manager.gitManager.getHeadAll(
            workspace.dir,
            repos
        );

        // Step 4: Run Claude Code in workspace dir
        const { volumeMount, workdir } = getDockerMount(
            workspace.dir,
            manager.config.server.workspaceDir
        );
        console.log(`[${task.id}] Running Claude Code in workspace...`);
        const systemPrompt = project.data.claudeCode.systemPrompt ?? "";
        const fullPrompt =
            task.data.prompt +
            buildSystemInstructions(repos, project.data.protectedPaths) +
            (systemPrompt ? `\n\n${systemPrompt}` : "");
        const result = await executor.run(
            fullPrompt,
            volumeMount,
            workdir,
            task.id
        );

        task.data.output = result.output;

        // Step 5: Check for uncommitted changes and ask Claude to commit if needed
        const hasUncommitted = await manager.gitManager.hasUncommittedChanges(
            workspace.dir,
            repos
        );
        if (hasUncommitted) {
            console.log(
                `[${task.id}] Uncommitted changes detected, asking Claude to commit...`
            );
            const commitPrompt = `You have uncommitted changes in the workspace. Stage all changes with "git add" and commit them with a clear conventional commit message. Do NOT push.`;
            await executor.run(commitPrompt, volumeMount, workdir, task.id);
        }

        // Step 6: Revert any changes to protected paths before creating the PR.
        const protectedPaths = project.data.protectedPaths ?? [];
        if (protectedPaths.length > 0) {
            console.log(`[${task.id}] Reverting protected path changes...`);
            await manager.gitManager.revertProtectedPathsAll(
                workspace.dir,
                repos,
                protectedPaths
            );
        }

        // Step 7: Ensure our branch points to HEAD (handles Claude switching branches)
        const hasCommits = await manager.gitManager.ensureBranchAtHeadAll(
            workspace.dir,
            repos,
            branchName,
            preRunHeads
        );

        // Step 8: Rebase on latest default branch to avoid conflicts in PR
        if (hasCommits) {
            console.log(`[${task.id}] Rebasing on latest default branch...`);
            const { conflicted } = await manager.gitManager.rebaseOnDefaultAll(
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
                    `[${task.id}] Rebase conflicts in ${conflicted.map((r) => r.name).join(", ")} — asking Claude to resolve...`
                );
                const rebasePrompt = `Some repositories need rebasing with conflict resolution:\n${repoInstructions}\nResolve every conflict by keeping the intent of your changes while incorporating the upstream updates. Do NOT push.`;
                await executor.run(rebasePrompt, volumeMount, workdir, task.id);
            }
        }

        // If the task was cancelled while running, respect that status (cancel() already set it)
        if (task.cancelled) {
            console.log(`[${task.id}] Task was cancelled.`);
            return;
        }

        if (result.exitCode === 0) {
            if (hasCommits) {
                // Success with commits: force-push (rebase rewrites history) and create ready PR
                console.log(`[${task.id}] Pushing branches...`);
                await manager.gitManager.pushBranchAll(
                    workspace.dir,
                    repos,
                    branchName,
                    true,
                    githubToken
                );

                // Build PR body from Claude's summary + commit log
                const assistantMessage = extractLastAssistantMessage(
                    task.data.output
                );
                const commitLogs = await manager.gitManager.getCommitLogAll(
                    workspace.dir,
                    repos,
                    branchName,
                    preRunHeads
                );
                const prBody = buildPrBody(assistantMessage, commitLogs);

                console.log(`[${task.id}] Creating pull request(s)...`);
                const prTitle = task.data.prompt.split("\n")[0].slice(0, 120);
                try {
                    const pullRequests =
                        await manager.gitManager.createPullRequestAll(
                            workspace.dir,
                            repos,
                            branchName,
                            prTitle,
                            prBody,
                            false,
                            githubToken
                        );
                    if (pullRequests.length > 0) {
                        task.data.pullRequests = pullRequests;
                        console.log(
                            `[${task.id}] Created ${pullRequests.length} PR(s): ${pullRequests.map((pr) => pr.url).join(", ")}`
                        );

                        // Post original task prompt as a comment
                        const taskComment = `## Task\n\n${task.data.prompt}`;
                        await manager.gitManager.commentOnPullRequestAll(
                            workspace.dir,
                            pullRequests,
                            taskComment,
                            githubToken
                        );
                    }
                } catch (prErr) {
                    console.error(
                        `[${task.id}] PR creation failed:`,
                        prErr instanceof Error ? prErr.message : String(prErr)
                    );
                }

                task.complete();
                console.log(`[${task.id}] Completed and pushed successfully.`);
            } else {
                // Success with no commits — keep the branch for future chain tasks
                console.log(
                    `[${task.id}] No new commits — leaving branch intact.`
                );
                task.complete();
            }
        } else if (result.timedOut) {
            // Timeout: push any partial work, preserve the branch, and re-enqueue
            // so the task is automatically resumed on the next server start (or manual retry).
            if (hasCommits) {
                console.log(
                    `[${task.id}] Timed out with partial commits — pushing work...`
                );
                await manager.gitManager.pushBranchAll(
                    workspace.dir,
                    repos,
                    branchName,
                    true,
                    githubToken
                );

                const assistantMessage = extractLastAssistantMessage(
                    task.data.output
                );
                const commitLogs = await manager.gitManager.getCommitLogAll(
                    workspace.dir,
                    repos,
                    branchName,
                    preRunHeads
                );
                const prBody = buildPrBody(assistantMessage, commitLogs);

                console.log(
                    `[${task.id}] Creating draft pull request(s) for partial work...`
                );
                const prTitle = task.data.prompt.split("\n")[0].slice(0, 120);
                try {
                    const pullRequests =
                        await manager.gitManager.createPullRequestAll(
                            workspace.dir,
                            repos,
                            branchName,
                            prTitle,
                            prBody,
                            true,
                            githubToken
                        );
                    if (pullRequests.length > 0) {
                        task.data.pullRequests = pullRequests;
                        console.log(
                            `[${task.id}] Created ${pullRequests.length} draft PR(s): ${pullRequests.map((pr) => pr.url).join(", ")}`
                        );

                        const taskComment = `## Task\n\n${task.data.prompt}`;
                        await manager.gitManager.commentOnPullRequestAll(
                            workspace.dir,
                            pullRequests,
                            taskComment,
                            githubToken
                        );
                    }
                } catch (prErr) {
                    console.error(
                        `[${task.id}] Draft PR creation failed:`,
                        prErr instanceof Error ? prErr.message : String(prErr)
                    );
                }
            } else {
                console.log(
                    `[${task.id}] Timed out with no commits — branch preserved for continuation.`
                );
            }

            // Preserve the branch so the next attempt can continue from where we left off.
            // Timeouts always retry immediately regardless of errorRetry config.
            task.fail(
                `Timed out after ${project.data.claudeCode.timeoutSeconds} seconds`
            );
            console.log(`[${task.id}] Timed out — re-enqueued for retry.`);
        } else {
            if (hasCommits) {
                // Failure with commits: force-push partial work and create draft PR
                console.log(
                    `[${task.id}] Failed but has commits — pushing partial work...`
                );
                await manager.gitManager.pushBranchAll(
                    workspace.dir,
                    repos,
                    branchName,
                    true,
                    githubToken
                );

                // Build PR body from Claude's summary + commit log
                const assistantMessage = extractLastAssistantMessage(
                    task.data.output
                );
                const commitLogs = await manager.gitManager.getCommitLogAll(
                    workspace.dir,
                    repos,
                    branchName,
                    preRunHeads
                );
                const prBody = buildPrBody(assistantMessage, commitLogs);

                console.log(`[${task.id}] Creating draft pull request(s)...`);
                const prTitle = task.data.prompt.split("\n")[0].slice(0, 120);
                try {
                    const pullRequests =
                        await manager.gitManager.createPullRequestAll(
                            workspace.dir,
                            repos,
                            branchName,
                            prTitle,
                            prBody,
                            true,
                            githubToken
                        );
                    if (pullRequests.length > 0) {
                        task.data.pullRequests = pullRequests;
                        console.log(
                            `[${task.id}] Created ${pullRequests.length} draft PR(s): ${pullRequests.map((pr) => pr.url).join(", ")}`
                        );

                        // Post original task prompt as a comment
                        const taskComment = `## Task\n\n${task.data.prompt}`;
                        await manager.gitManager.commentOnPullRequestAll(
                            workspace.dir,
                            pullRequests,
                            taskComment,
                            githubToken
                        );
                    }
                } catch (prErr) {
                    console.error(
                        `[${task.id}] Draft PR creation failed:`,
                        prErr instanceof Error ? prErr.message : String(prErr)
                    );
                }
            } else {
                // Failure with no commits — keep the branch for potential retries
                console.log(
                    `[${task.id}] Failed with no commits — leaving branch intact.`
                );
            }

            task.fail(`Claude Code exited with code ${result.exitCode}`);
            console.log(
                `[${task.id}] Failed with exit code ${result.exitCode}.`
            );
        }
    } catch (err) {
        // If cancelled, preserve the cancelled status (don't overwrite with failed)
        if (!task.cancelled) {
            task.data.output = executor.getOutput();
            task.fail(err instanceof Error ? err.message : String(err));
            console.error(`[${task.id}] Error:`, task.data.error);
        } else {
            console.log(
                `[${task.id}] Task was cancelled (caught during execution).`
            );
        }
    } finally {
        task.tickUpdate();
        project.pool.release(workspace.id);
        // Start next queued task for this project if capacity is now available
        manager.dequeueAvailableTasks();
    }
}

export async function generateMetadata(task: Task): Promise<{
    branchName: string;
    title: string;
    estimatedDurationSeconds: number;
}> {
    try {
        console.log(
            `[${task.id}] Generating branch name, title, and duration estimate...`
        );
        const metaExecutor = new Executor(
            task.project.data.claudeCode,
            task.project.tokenManager,
            task.manager.config.server
        );
        const { slug, title, estimatedDurationSeconds } =
            await metaExecutor.generateTaskMetadata(task.data.prompt, task.id);

        return {
            branchName: `impl/${slug}-${task.id}`,
            title,
            estimatedDurationSeconds
        };
    } catch (err) {
        console.error(`[${task.id}] Failed to prepare branchless task:`, err);
        throw err;
    }
}
