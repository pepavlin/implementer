import { nanoid } from "nanoid";
import type { Config, Task, TaskCreateRequest } from "./types.js";
import { GitManager } from "./git-manager.js";
import { Executor } from "./executor.js";
import { WorkspacePool } from "./workspace-pool.js";

const COMMIT_INSTRUCTIONS = `

IMPORTANT: When committing changes, write clear and descriptive commit messages using conventional commits format (e.g. "feat: add animated hero section with cat image", "fix: resolve navigation hover styles"). Each commit should be a logical unit of work with a message that explains what was done and why.`;

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
    this.pool = new WorkspacePool(config.server.workspaceDir);
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

    try {
      // Step 1: Prepare branch in all repos
      if (fromBranch) {
        console.log(`[${task.taskId}] Checking out continuation branch: ${fromBranch}`);
        await this.gitManager.checkoutBranchAll(workspace.dir, repos, fromBranch);
      } else {
        console.log(`[${task.taskId}] Creating new branch: ${task.branch}`);
        await this.gitManager.prepareNewBranchAll(workspace.dir, repos, task.branch);
      }

      // Step 2: Run Claude Code in workspace dir
      console.log(`[${task.taskId}] Running Claude Code in workspace ${workspace.id}...`);
      const fullPrompt = task.prompt + COMMIT_INSTRUCTIONS;
      const result = await entry.executor.run(fullPrompt, workspace.dir);

      task.output = result.output;

      if (result.exitCode === 0) {
        // Step 3: Push branch in all repos
        console.log(`[${task.taskId}] Pushing branches...`);
        await this.gitManager.pushBranchAll(workspace.dir, repos, task.branch);

        task.status = "completed";
        console.log(`[${task.taskId}] Completed and pushed successfully.`);
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
