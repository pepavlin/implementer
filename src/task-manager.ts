import { nanoid } from "nanoid";
import type { Config, PersistedTask, Task, TaskCreateRequest } from "./types.js";
import { GitManager } from "./git-manager.js";
import { Executor } from "./executor.js";
import { WorkspacePool, chownRecursive } from "./workspace-pool.js";
import { TaskStore } from "./task-store.js";
import type { TokenManager } from "./auth.js";

function buildSystemInstructions(repos: { name: string }[]): string {
  const repoList = repos.map((r) => r.name).join(", ");
  return `

IMPORTANT WORKSPACE RULES:
- Your workspace contains the following git repositories: ${repoList}. Always work INSIDE the repository directory (e.g. cd ${repos[0]?.name ?? "repo"} first). Do NOT create new git repositories or run git init.
- After making all changes, you MUST commit them using git. Stage your changes with "git add" and commit with "git commit". Write clear and descriptive commit messages using conventional commits format (e.g. "feat: add animated hero section with cat image", "fix: resolve navigation hover styles"). Each commit should be a logical unit of work with a message that explains what was done and why. Do NOT push — only commit.
- When you need to visually inspect a web application, ALWAYS start the dev server locally first (e.g. npm start, npm run dev) and use Playwright on the local URL (http://localhost:...). NEVER screenshot external/production URLs — you must test against the local code in your workspace so your changes are reflected.`;
}

interface TaskEntry {
  task: Task;
  executor: Executor | null;
  workspaceId: number;
}

export class TaskManager {
  private config: Config;
  private gitManager: GitManager;
  private pool: WorkspacePool;
  private tokenManager: TokenManager;
  private store: TaskStore;
  private tasks: Map<string, TaskEntry> = new Map();

  constructor(config: Config, tokenManager: TokenManager) {
    this.config = config;
    this.tokenManager = tokenManager;
    this.gitManager = new GitManager();
    this.pool = new WorkspacePool(config.server.workspaceDir, config.claudeCode.mcpServers, config.server.maxConcurrentTasks);
    this.store = new TaskStore(config.server.workspaceDir);

    if (process.env.WORKSPACE_VOLUME) {
      console.log(`Docker volume mode: sandbox containers mount volume "${process.env.WORKSPACE_VOLUME}"`);
    } else if (process.env.WORKSPACE_HOST_DIR) {
      console.log(`Docker bind mode: mapping ${config.server.workspaceDir} → ${process.env.WORKSPACE_HOST_DIR} for sandbox mounts`);
    }
  }

  /**
   * Initialize task manager: rediscover workspaces, load persisted tasks,
   * mark running tasks as interrupted, and resume them.
   */
  async init(): Promise<void> {
    // Rediscover existing workspace directories from disk
    this.pool.initFromDisk();

    // Load all persisted tasks
    const persisted = this.store.loadAll();
    console.log(`[task-manager] Loaded ${persisted.length} persisted task(s) from disk`);

    for (const pt of persisted) {
      // Mark tasks that were "running" as "interrupted"
      if (pt.status === "running") {
        pt.status = "interrupted";
        pt.output = "";
        this.store.save(pt);
        console.log(`[task-manager] Task ${pt.taskId} marked as interrupted`);
      }

      // Populate in-memory map (no live executor for historical tasks)
      this.tasks.set(pt.taskId, {
        task: pt,
        executor: null,
        workspaceId: pt.workspaceId,
      });
    }

    // Resume interrupted tasks
    await this.resumeInterruptedTasks();
  }

  private async resumeInterruptedTasks(): Promise<void> {
    const repos = this.config.repositories;
    const interrupted = Array.from(this.tasks.values()).filter(
      (e) => e.task.status === "interrupted",
    );

    if (interrupted.length === 0) return;
    console.log(`[task-manager] Resuming ${interrupted.length} interrupted task(s)...`);

    for (const entry of interrupted) {
      try {
        const workspace = await this.pool.acquireExisting(entry.workspaceId, repos);
        const executor = new Executor(this.config.claudeCode, this.tokenManager);
        entry.executor = executor;
        entry.task.status = "running";
        entry.task.output = "";

        const persistedTask: PersistedTask = { ...entry.task, workspaceId: entry.workspaceId };
        this.store.save(persistedTask);

        console.log(`[task-manager] Resuming task ${entry.task.taskId} on workspace ${entry.workspaceId}`);

        // Fire in background with fromBranch so it checks out the existing branch
        this.executeTask(entry.task, workspace, entry.task.branch ?? undefined).catch((err) => {
          console.error(`Task ${entry.task.taskId} resumption failed:`, err);
        });
      } catch (err) {
        console.error(`[task-manager] Failed to resume task ${entry.task.taskId}:`, err);
        entry.task.status = "failed";
        entry.task.error = `Resumption failed: ${err instanceof Error ? err.message : String(err)}`;
        entry.task.completedAt = new Date().toISOString();
        const persistedTask: PersistedTask = { ...entry.task, workspaceId: entry.workspaceId };
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
  private getDockerMount(workspaceDir: string): { volumeMount: string; workdir: string } {
    const volume = process.env.WORKSPACE_VOLUME;
    if (volume) {
      const relativePath = workspaceDir.replace(this.config.server.workspaceDir, "");
      return {
        volumeMount: `${volume}:/workspace`,
        workdir: `/workspace${relativePath}`,
      };
    }

    const hostDir = process.env.WORKSPACE_HOST_DIR;
    if (hostDir) {
      const hostPath = workspaceDir.replace(this.config.server.workspaceDir, hostDir);
      return { volumeMount: `${hostPath}:/workspace`, workdir: "/workspace" };
    }

    return { volumeMount: `${workspaceDir}:/workspace`, workdir: "/workspace" };
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId)?.task;
  }

  listTasks(): Task[] {
    return Array.from(this.tasks.values()).map((entry) => entry.task);
  }

  getOutput(taskId: string): string {
    const entry = this.tasks.get(taskId);
    if (!entry) return "";
    if (entry.task.status === "running" && entry.executor) {
      return entry.executor.getOutput();
    }
    return entry.task.output;
  }

  /**
   * Start a new task. Always accepts — tasks run in parallel on isolated workspaces.
   */
  async startTask(request: TaskCreateRequest): Promise<Task> {
    const taskId = nanoid(8);
    const executor = new Executor(this.config.claudeCode, this.tokenManager);

    // Generate branch name before returning response
    let branch: string;
    if (request.fromBranch) {
      branch = request.fromBranch;
    } else {
      console.log(`[${taskId}] Generating branch name...`);
      const slug = await executor.generateBranchSlug(request.prompt, taskId);
      branch = `impl/${slug}-${taskId}`;
      console.log(`[${taskId}] Branch: ${branch}`);
    }

    const task: Task = {
      taskId,
      branch,
      prompt: request.prompt,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      output: "",
    };

    // Acquire a workspace instance (clone or reuse)
    const workspace = await this.pool.acquire(this.config.repositories);

    this.tasks.set(taskId, { task, executor, workspaceId: workspace.id });

    // Persist to disk
    this.store.save({ ...task, workspaceId: workspace.id });

    // Run async - don't await, let it run in background
    this.executeTask(task, workspace, request.fromBranch).catch((err) => {
      console.error(`Task ${taskId} failed unexpectedly:`, err);
    });

    return task;
  }

  private async executeTask(
    task: Task,
    workspace: { id: number; dir: string },
    fromBranch?: string,
  ): Promise<void> {
    const repos = this.config.repositories;
    const entry = this.tasks.get(task.taskId)!;
    const executor = entry.executor!;
    const branchName = task.branch!;

    try {
      // Step 1: Prepare branch in all repos
      if (fromBranch) {
        console.log(`[${task.taskId}] Checking out continuation branch: ${fromBranch}`);
        await this.gitManager.checkoutBranchAll(workspace.dir, repos, fromBranch);
      } else {
        console.log(`[${task.taskId}] Creating new branch: ${branchName}`);
        await this.gitManager.prepareNewBranchAll(workspace.dir, repos, branchName);
      }

      // Step 2: Push branch to remote immediately so it's visible in GitHub
      console.log(`[${task.taskId}] Pushing branch to remote...`);
      await this.gitManager.pushBranchAll(workspace.dir, repos, branchName);

      // Rechown after branch creation (new refs are owned by root)
      await chownRecursive(workspace.dir);

      // Step 3: Save pre-run HEAD hashes to detect new commits later
      const preRunHeads = await this.gitManager.getHeadAll(workspace.dir, repos);

      // Step 4: Run Claude Code in workspace dir
      const { volumeMount, workdir } = this.getDockerMount(workspace.dir);
      console.log(`[${task.taskId}] Running Claude Code in workspace ${workspace.id}...`);
      const systemPrompt = this.config.claudeCode.systemPrompt ?? "";
      const fullPrompt = task.prompt + buildSystemInstructions(repos) + (systemPrompt ? `\n\n${systemPrompt}` : "");
      const result = await executor.run(fullPrompt, volumeMount, workdir, task.taskId);

      task.output = result.output;

      // Step 5: Check for uncommitted changes and ask Claude to commit if needed
      const hasUncommitted = await this.gitManager.hasUncommittedChanges(workspace.dir, repos);
      if (hasUncommitted) {
        console.log(`[${task.taskId}] Uncommitted changes detected, asking Claude to commit...`);
        const commitPrompt = `You have uncommitted changes in the workspace. Stage all changes with "git add" and commit them with a clear conventional commit message. Do NOT push.`;
        await executor.run(commitPrompt, volumeMount, workdir, task.taskId);
      }

      // Step 6: Ensure our branch points to HEAD (handles Claude switching branches)
      const hasCommits = await this.gitManager.ensureBranchAtHeadAll(workspace.dir, repos, branchName, preRunHeads);

      // Step 7: Rebase on latest default branch to avoid conflicts in PR
      if (hasCommits) {
        console.log(`[${task.taskId}] Rebasing on latest default branch...`);
        const { conflicted } = await this.gitManager.rebaseOnDefaultAll(workspace.dir, repos, branchName);

        if (conflicted.length > 0) {
          // Rechown after fetch/rebase so sandbox container (UID 1000) can write git objects
          await chownRecursive(workspace.dir);

          const repoInstructions = conflicted.map(
            (r) => `- cd ${r.name} && git rebase origin/${r.defaultBranch} — resolve all conflicts, then git add the resolved files and git rebase --continue. Repeat until rebase completes.`,
          ).join("\n");
          console.log(`[${task.taskId}] Rebase conflicts in ${conflicted.map((r) => r.name).join(", ")} — asking Claude to resolve...`);
          const rebasePrompt = `Some repositories need rebasing with conflict resolution:\n${repoInstructions}\nResolve every conflict by keeping the intent of your changes while incorporating the upstream updates. Do NOT push.`;
          await executor.run(rebasePrompt, volumeMount, workdir, task.taskId);
        }
      }

      if (result.exitCode === 0) {
        if (hasCommits) {
          // Success with commits: force-push (rebase rewrites history) and create ready PR
          console.log(`[${task.taskId}] Pushing branches...`);
          await this.gitManager.pushBranchAll(workspace.dir, repos, branchName, true);

          console.log(`[${task.taskId}] Creating pull request(s)...`);
          const prTitle = task.prompt.split("\n")[0].slice(0, 120);
          const prBody = task.prompt;
          try {
            const pullRequests = await this.gitManager.createPullRequestAll(
              workspace.dir, repos, branchName, prTitle, prBody,
            );
            if (pullRequests.length > 0) {
              task.pullRequests = pullRequests;
              console.log(`[${task.taskId}] Created ${pullRequests.length} PR(s): ${pullRequests.map((pr) => pr.url).join(", ")}`);
            }
          } catch (prErr) {
            console.error(`[${task.taskId}] PR creation failed:`, prErr instanceof Error ? prErr.message : String(prErr));
          }

          task.status = "completed";
          console.log(`[${task.taskId}] Completed and pushed successfully.`);
        } else {
          // Success with no commits: delete remote branch and clear branch ref
          console.log(`[${task.taskId}] No new commits — cleaning up remote branch.`);
          await this.gitManager.deleteRemoteBranchAll(workspace.dir, repos, branchName);
          task.branch = null;
          task.status = "completed";
        }
      } else {
        if (hasCommits) {
          // Failure with commits: force-push partial work and create draft PR
          console.log(`[${task.taskId}] Failed but has commits — pushing partial work...`);
          await this.gitManager.pushBranchAll(workspace.dir, repos, branchName, true);

          console.log(`[${task.taskId}] Creating draft pull request(s)...`);
          const prTitle = task.prompt.split("\n")[0].slice(0, 120);
          const prBody = task.prompt;
          try {
            const pullRequests = await this.gitManager.createPullRequestAll(
              workspace.dir, repos, branchName, prTitle, prBody, true,
            );
            if (pullRequests.length > 0) {
              task.pullRequests = pullRequests;
              console.log(`[${task.taskId}] Created ${pullRequests.length} draft PR(s): ${pullRequests.map((pr) => pr.url).join(", ")}`);
            }
          } catch (prErr) {
            console.error(`[${task.taskId}] Draft PR creation failed:`, prErr instanceof Error ? prErr.message : String(prErr));
          }
        } else {
          // Failure with no commits: delete remote branch
          console.log(`[${task.taskId}] Failed with no commits — cleaning up remote branch.`);
          await this.gitManager.deleteRemoteBranchAll(workspace.dir, repos, branchName);
          task.branch = null;
        }

        task.status = "failed";
        task.error = `Claude Code exited with code ${result.exitCode}`;
        console.log(`[${task.taskId}] Failed with exit code ${result.exitCode}.`);
      }
    } catch (err) {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      task.output = executor.getOutput();
      console.error(`[${task.taskId}] Error:`, task.error);
    } finally {
      task.completedAt = new Date().toISOString();
      this.store.save({ ...task, workspaceId: workspace.id });
      this.pool.release(workspace.id);
    }
  }
}
