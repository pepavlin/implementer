import { nanoid } from "nanoid";
import type { Config, RepositoryConfig, Task, TaskCreateRequest } from "./types.js";
import { GitManager } from "./git-manager.js";
import { Executor } from "./executor.js";

export class TaskManager {
  private config: Config;
  private gitManager: GitManager;
  private currentTask: Task | null = null;
  private lastTask: Task | null = null;
  private executor: Executor | null = null;

  constructor(config: Config) {
    this.config = config;
    this.gitManager = new GitManager(config.server.workspaceDir);
  }

  isRunning(): boolean {
    return this.currentTask?.status === "running";
  }

  getCurrentTask(): Task | null {
    return this.currentTask;
  }

  getLastTask(): Task | null {
    return this.lastTask;
  }

  getOutput(): string {
    if (this.executor) {
      return this.executor.getOutput();
    }
    return this.currentTask?.output ?? this.lastTask?.output ?? "";
  }

  getActiveTaskId(): string | null {
    return this.currentTask?.taskId ?? null;
  }

  findRepository(name: string): RepositoryConfig | undefined {
    return this.config.repositories.find((r) => r.name === name);
  }

  /**
   * Start a new task. Rejects if a task is already running.
   */
  async startTask(request: TaskCreateRequest): Promise<Task> {
    if (this.isRunning()) {
      throw new TaskBusyError(this.currentTask!);
    }

    const repo = this.findRepository(request.repository);
    if (!repo) {
      throw new Error(`Repository "${request.repository}" not found in config`);
    }

    const taskId = nanoid(8);
    const branch = request.fromBranch ?? `impl/${taskId}`;

    const task: Task = {
      taskId,
      repository: request.repository,
      branch,
      prompt: request.prompt,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      output: "",
    };

    this.currentTask = task;
    this.executor = new Executor(this.config.claudeCode);

    // Run async - don't await, let it run in background
    this.executeTask(repo, task, request.fromBranch).catch((err) => {
      console.error(`Task ${taskId} failed unexpectedly:`, err);
    });

    return task;
  }

  private async executeTask(
    repo: RepositoryConfig,
    task: Task,
    fromBranch?: string
  ): Promise<void> {
    try {
      // Step 1: Ensure repo is cloned/fetched
      console.log(`[${task.taskId}] Ensuring repo "${repo.name}" is ready...`);
      await this.gitManager.ensureRepo(repo);

      // Step 2: Prepare branch
      if (fromBranch) {
        console.log(`[${task.taskId}] Checking out continuation branch: ${fromBranch}`);
        await this.gitManager.checkoutBranch(repo, fromBranch);
      } else {
        console.log(`[${task.taskId}] Creating new branch: ${task.branch}`);
        task.branch = await this.gitManager.prepareNewBranch(repo, task.taskId);
      }

      // Step 3: Run Claude Code
      console.log(`[${task.taskId}] Running Claude Code...`);
      const repoDir = this.gitManager.getRepoDir(repo.name);
      const result = await this.executor!.run(task.prompt, repoDir);

      task.output = result.output;

      if (result.exitCode === 0) {
        // Step 4: Push branch to origin
        console.log(`[${task.taskId}] Pushing branch ${task.branch}...`);
        await this.gitManager.pushBranch(repo.name, task.branch);

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
      task.output = this.executor?.getOutput() ?? "";
      console.error(`[${task.taskId}] Error:`, task.error);
    } finally {
      task.completedAt = new Date().toISOString();
      this.lastTask = { ...task };
      this.currentTask = null;
      this.executor = null;
    }
  }
}

export class TaskBusyError extends Error {
  public currentTask: Task;

  constructor(currentTask: Task) {
    super("Task already running");
    this.name = "TaskBusyError";
    this.currentTask = currentTask;
  }
}
