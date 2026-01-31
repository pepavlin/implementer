import { nanoid } from "nanoid";
import type { Config, Task, TaskCreateRequest } from "./types.js";
import { GitManager } from "./git-manager.js";
import { Executor } from "./executor.js";
import { WorkspacePool, chownRecursive } from "./workspace-pool.js";

function buildSystemInstructions(repos: { name: string }[]): string {
  const repoList = repos.map((r) => r.name).join(", ");
  return `

IMPORTANT WORKSPACE RULES:
- Your workspace contains the following git repositories: ${repoList}. Always work INSIDE the repository directory (e.g. cd ${repos[0]?.name ?? "repo"} first). Do NOT create new git repositories or run git init.
- After making all changes, you MUST commit them using git. Stage your changes with "git add" and commit with "git commit". Write clear and descriptive commit messages using conventional commits format (e.g. "feat: add animated hero section with cat image", "fix: resolve navigation hover styles"). Each commit should be a logical unit of work with a message that explains what was done and why. Do NOT push — only commit.`;
}

interface TaskEntry {
  task: Task;
  executor: Executor;
  workspaceId: number;
}

export class TaskManager {
  private config: Config;
  private gitManager: GitManager;
  private pool: WorkspacePool;
  private tasks: Map<string, TaskEntry> = new Map();

  constructor(config: Config) {
    this.config = config;
    this.gitManager = new GitManager();
    this.pool = new WorkspacePool(config.server.workspaceDir, config.claudeCode.mcpServers);

    if (process.env.WORKSPACE_VOLUME) {
      console.log(`Docker volume mode: sandbox containers mount volume "${process.env.WORKSPACE_VOLUME}"`);
    } else if (process.env.WORKSPACE_HOST_DIR) {
      console.log(`Docker bind mode: mapping ${config.server.workspaceDir} → ${process.env.WORKSPACE_HOST_DIR} for sandbox mounts`);
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
    if (entry.task.status === "running") {
      return entry.executor.getOutput();
    }
    return entry.task.output;
  }

  /**
   * Start a new task. Always accepts — tasks run in parallel on isolated workspaces.
   */
  async startTask(request: TaskCreateRequest): Promise<Task> {
    const taskId = nanoid(8);
    const executor = new Executor(this.config.claudeCode);

    // Generate branch name before returning response
    let branch: string;
    if (request.fromBranch) {
      branch = request.fromBranch;
    } else {
      console.log(`[${taskId}] Generating branch name...`);
      const slug = await executor.generateBranchSlug(request.prompt);
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

      // Rechown after branch creation (new refs are owned by root)
      await chownRecursive(workspace.dir);

      // Step 2: Save pre-run HEAD hashes to detect new commits later
      const preRunHeads = await this.gitManager.getHeadAll(workspace.dir, repos);

      // Step 3: Run Claude Code in workspace dir
      const { volumeMount, workdir } = this.getDockerMount(workspace.dir);
      console.log(`[${task.taskId}] Running Claude Code in workspace ${workspace.id}...`);
      const fullPrompt = task.prompt + buildSystemInstructions(repos);
      const result = await entry.executor.run(fullPrompt, volumeMount, workdir);

      task.output = result.output;

      if (result.exitCode === 0) {
        // Step 4: Check for uncommitted changes and ask Claude to commit if needed
        const hasUncommitted = await this.gitManager.hasUncommittedChanges(workspace.dir, repos);
        if (hasUncommitted) {
          console.log(`[${task.taskId}] Uncommitted changes detected, asking Claude to commit...`);
          const commitPrompt = `You have uncommitted changes in the workspace. Stage all changes with "git add" and commit them with a clear conventional commit message. Do NOT push.`;
          await entry.executor.run(commitPrompt, volumeMount, workdir);
        }

        // Step 5: Ensure our branch points to HEAD (handles Claude switching branches)
        const hasCommits = await this.gitManager.ensureBranchAtHeadAll(workspace.dir, repos, branchName, preRunHeads);
        if (hasCommits) {
          console.log(`[${task.taskId}] Pushing branches...`);
          await this.gitManager.pushBranchAll(workspace.dir, repos, branchName);
          task.status = "completed";
          console.log(`[${task.taskId}] Completed and pushed successfully.`);
        } else {
          console.log(`[${task.taskId}] No new commits — skipping push.`);
          task.branch = null;
          task.status = "completed";
        }
      } else {
        task.status = "failed";
        task.error = `Claude Code exited with code ${result.exitCode}`;
        console.log(`[${task.taskId}] Failed with exit code ${result.exitCode}.`);
      }
    } catch (err) {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      task.output = entry.executor.getOutput();
      console.error(`[${task.taskId}] Error:`, task.error);
    } finally {
      task.completedAt = new Date().toISOString();
      this.pool.release(workspace.id);
    }
  }
}
