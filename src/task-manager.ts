import { nanoid } from "nanoid";
import type { Config, Task, TaskCreateRequest } from "./types.js";
import { GitManager } from "./git-manager.js";
import { Executor } from "./executor.js";

const COMMIT_INSTRUCTIONS = `

IMPORTANT: When committing changes, write clear and descriptive commit messages using conventional commits format (e.g. "feat: add animated hero section with cat image", "fix: resolve navigation hover styles"). Each commit should be a logical unit of work with a message that explains what was done and why.`;

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

  /**
   * Start a new task. Rejects if a task is already running.
   */
  async startTask(request: TaskCreateRequest): Promise<Task> {
    if (this.isRunning()) {
      throw new TaskBusyError(this.currentTask!);
    }

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

    this.currentTask = task;
    this.executor = executor;

    // Run async - don't await, let it run in background
    this.executeTask(task, request.fromBranch).catch((err) => {
      console.error(`Task ${taskId} failed unexpectedly:`, err);
    });

    return task;
  }

  private async executeTask(task: Task, fromBranch?: string): Promise<void> {
    const repos = this.config.repositories;

    try {
      // Step 1: Ensure all repos are cloned/fetched
      console.log(`[${task.taskId}] Ensuring all repos are ready...`);
      await this.gitManager.ensureAllRepos(repos);

      // Step 2: Prepare branch in all repos
      if (fromBranch) {
        console.log(`[${task.taskId}] Checking out continuation branch: ${fromBranch}`);
        await this.gitManager.checkoutBranchAll(repos, fromBranch);
      } else {
        console.log(`[${task.taskId}] Creating new branch: ${task.branch}`);
        await this.gitManager.prepareNewBranchAll(repos, task.branch);
      }

      // Step 3: Run Claude Code in workspace root
      console.log(`[${task.taskId}] Running Claude Code...`);
      const workspaceDir = this.gitManager.getWorkspaceDir();
      const fullPrompt = task.prompt + COMMIT_INSTRUCTIONS;
      const result = await this.executor!.run(fullPrompt, workspaceDir);

      task.output = result.output;

      if (result.exitCode === 0) {
        // Step 4: Push branch in all repos
        console.log(`[${task.taskId}] Pushing branches...`);
        await this.gitManager.pushBranchAll(repos, task.branch);

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
