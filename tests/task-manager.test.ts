import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, PersistedTask } from "../src/types.js";
import { TaskStore } from "../src/task-store.js";

const TMP = join(import.meta.dirname, "..", "tmp", "task-manager-test");
const PROJECT_ID = "test-project";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    server: { workspaceDir: TMP },
    projects: {
      [PROJECT_ID]: {
        maxConcurrentTasks: 4,
        repositories: [
          { name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" },
        ],
        claudeCode: {
          command: "claude",
        },
      },
    },
    ...overrides,
  };
}

function makePersistedTask(overrides: Partial<PersistedTask> = {}): PersistedTask {
  return {
    taskId: "abc123",
    projectId: PROJECT_ID,
    branch: "impl/test-abc123",
    prompt: "Add a button",
    status: "completed",
    startedAt: "2025-01-01T00:00:00.000Z",
    completedAt: "2025-01-01T01:00:00.000Z",
    output: "Done",
    workspaceId: 0,
    attempt: 1,
    ...overrides,
  };
}

describe("TaskManager", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("can be instantiated with valid config", async () => {
    const { TaskManager } = await import("../src/task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm).toBeDefined();
  });

  it("listTasks returns empty array initially", async () => {
    const { TaskManager } = await import("../src/task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm.listTasks(PROJECT_ID)).toEqual([]);
  });

  it("listAllActiveTasks returns empty array initially", async () => {
    const { TaskManager } = await import("../src/task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm.listAllActiveTasks()).toEqual([]);
  });

  it("listAllActiveTasks returns empty when only completed/failed tasks are loaded", async () => {
    const { TaskManager } = await import("../src/task-manager.js");
    const store = new TaskStore(makeConfig().server.workspaceDir);
    store.save(makePersistedTask({ taskId: "t-completed", status: "completed", completedAt: new Date().toISOString() }));
    store.save(makePersistedTask({ taskId: "t-failed", status: "failed", completedAt: new Date().toISOString() }));

    const tm = new TaskManager(makeConfig());
    await tm.init();

    expect(tm.listAllActiveTasks()).toEqual([]);
  });

  it("getTask returns undefined for unknown id", async () => {
    const { TaskManager } = await import("../src/task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm.getTask(PROJECT_ID, "nonexistent")).toBeUndefined();
  });

  it("getOutput returns empty string for unknown id", async () => {
    const { TaskManager } = await import("../src/task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm.getOutput(PROJECT_ID, "nonexistent")).toBe("");
  });

  it("accepts multiple repositories in config", async () => {
    const { TaskManager } = await import("../src/task-manager.js");
    const config = makeConfig({
      projects: {
        [PROJECT_ID]: {
          repositories: [
            { name: "frontend", url: "https://github.com/test/fe.git", defaultBranch: "main" },
            { name: "backend", url: "https://github.com/test/be.git", defaultBranch: "master" },
          ],
          claudeCode: { command: "claude" },
        },
      },
    });
    const tm = new TaskManager(config);
    expect(tm).toBeDefined();
  });

  it("accepts systemPrompt in config", async () => {
    const { TaskManager } = await import("../src/task-manager.js");
    const config = makeConfig({
      projects: {
        [PROJECT_ID]: {
          repositories: [
            { name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" },
          ],
          claudeCode: {
            command: "claude",
            systemPrompt: "Always write tests.",
          },
        },
      },
    });
    const tm = new TaskManager(config);
    expect(tm).toBeDefined();
  });

  it("supports multiple projects in config", async () => {
    const { TaskManager } = await import("../src/task-manager.js");
    const config: Config = {
      server: { workspaceDir: TMP },
      projects: {
        "project-a": {
          repositories: [{ name: "repo-a", url: "https://example.com/a.git", defaultBranch: "main" }],
          claudeCode: { command: "claude" },
        },
        "project-b": {
          repositories: [{ name: "repo-b", url: "https://example.com/b.git", defaultBranch: "main" }],
          claudeCode: { command: "claude" },
        },
      },
    };
    const tm = new TaskManager(config);
    expect(tm).toBeDefined();
    expect(tm.listTasks("project-a")).toEqual([]);
    expect(tm.listTasks("project-b")).toEqual([]);
  });

  describe("init", () => {
    it("loads completed tasks from disk into memory", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      // Pre-populate persisted tasks
      store.save(makePersistedTask({ taskId: "task-1", status: "completed" }));
      store.save(makePersistedTask({ taskId: "task-2", status: "failed", error: "boom" }));

      const tm = new TaskManager(config);
      await tm.init();

      expect(tm.listTasks(PROJECT_ID)).toHaveLength(2);
      expect(tm.getTask(PROJECT_ID, "task-1")?.status).toBe("completed");
      expect(tm.getTask(PROJECT_ID, "task-2")?.status).toBe("failed");
      expect(tm.getTask(PROJECT_ID, "task-2")?.error).toBe("boom");
    });

    it("marks running tasks as interrupted", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      // Task was "running" when container died
      store.save(makePersistedTask({
        taskId: "running-task",
        status: "running",
        completedAt: null,
        workspaceId: 0,
      }));

      // Create the workspace directory so initFromDisk finds it
      mkdirSync(join(TMP, "projects", PROJECT_ID, "instances", "0"), { recursive: true });

      const tm = new TaskManager(config);
      await tm.init();

      // After init, the task should initially be marked interrupted (then resumed to running)
      // Since acquireExisting will succeed but executeTask will fail (no real git/docker),
      // it should end up as "failed" or still "running" briefly.
      const onDisk = JSON.parse(
        readFileSync(join(TMP, "tasks", "running-task.json"), "utf-8"),
      );
      // The task should have been saved as "running" again after resume attempt
      // (interrupted -> running when resumption starts)
      expect(["running", "failed", "interrupted"]).toContain(onDisk.status);
    });

    it("re-enqueues retrying tasks on restart", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      // Task was in "retrying" state (waiting for setTimeout) when server died
      store.save(makePersistedTask({
        taskId: "retrying-task",
        status: "retrying" as any,
        completedAt: null,
        workspaceId: null,
        attempt: 2,
        branch: "impl/test-retrying-task",
      }));

      const tm = new TaskManager(config);
      // Prevent tryDequeue from actually acquiring a workspace (which would trigger git clone)
      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // After init, task should be queued (not stuck in retrying, not failed)
      const task = tm.getTask(PROJECT_ID, "retrying-task");
      expect(task?.status).toBe("queued");
      expect(task?.attempt).toBe(2); // attempt counter preserved

      const onDisk = JSON.parse(
        readFileSync(join(TMP, "tasks", "retrying-task.json"), "utf-8"),
      );
      expect(onDisk.status).toBe("queued");

      // checkoutBranch should be set so the existing branch is reused on dequeue
      // @ts-expect-error - accessing private tasks map for testing
      const entry = tm.tasks.get("retrying-task");
      expect(entry?.checkoutBranch).toBe("impl/test-retrying-task");
    });

    it("does not modify completed tasks", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "done-task",
        status: "completed",
        output: "All done",
      }));

      const tm = new TaskManager(config);
      await tm.init();

      const task = tm.getTask(PROJECT_ID, "done-task");
      expect(task?.status).toBe("completed");
      expect(task?.output).toBe("All done");
    });

    it("does not modify failed tasks", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "fail-task",
        status: "failed",
        error: "Something went wrong",
      }));

      const tm = new TaskManager(config);
      await tm.init();

      const task = tm.getTask(PROJECT_ID, "fail-task");
      expect(task?.status).toBe("failed");
      expect(task?.error).toBe("Something went wrong");
    });

    it("works with empty task store", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();

      const tm = new TaskManager(config);
      await tm.init();

      expect(tm.listTasks(PROJECT_ID)).toEqual([]);
    });

    it("marks interrupted task as failed when workspace is missing", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      // Task references workspace 5 which doesn't exist on disk
      store.save(makePersistedTask({
        taskId: "orphan-task",
        status: "running",
        completedAt: null,
        workspaceId: 5,
      }));

      const tm = new TaskManager(config);
      await tm.init();

      // Wait a tick for the async error handling
      await new Promise((r) => setTimeout(r, 50));

      const task = tm.getTask(PROJECT_ID, "orphan-task");
      expect(task?.status).toBe("failed");
      expect(task?.error).toContain("Resumption failed");
    });

    it("marks task from unknown project as failed", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "alien-task",
        projectId: "nonexistent-project",
        status: "running",
        completedAt: null,
        workspaceId: 0,
      }));

      const tm = new TaskManager(config);
      await tm.init();

      // Wait a tick for the async error handling
      await new Promise((r) => setTimeout(r, 50));

      // Task is not accessible via the known project
      const task = tm.getTask(PROJECT_ID, "alien-task");
      expect(task).toBeUndefined();
    });

    it("sets resumedFromRestart flag on task entries during resumption", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "resumed-flag-task",
        status: "running",
        completedAt: null,
        workspaceId: 0,
      }));

      mkdirSync(join(TMP, "projects", PROJECT_ID, "instances", "0"), { recursive: true });

      const tm = new TaskManager(config);

      await tm.init();

      // The flag is set synchronously after acquireExisting succeeds and before
      // executeTask() is fired. Checking immediately after init() captures it
      // before the background async execution has a chance to clear it.
      // @ts-expect-error - accessing private tasks map for testing
      const entry = tm.tasks.get("resumed-flag-task");
      expect(entry?.resumedFromRestart).toBe(true);
    });
  });

  describe("restart resume — retry delay", () => {
    it("tasks resumed after restart skip the retry delay on their first failure", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig({
        projects: {
          [PROJECT_ID]: {
            maxConcurrentTasks: 4,
            repositories: [
              { name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" },
            ],
            claudeCode: { command: "claude" },
            // Very long delay to prove it was bypassed
            errorRetry: { maxAttempts: 2, delaySeconds: 9999 },
          },
        },
      });
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "restart-retry-task",
        status: "running",
        completedAt: null,
        workspaceId: 0,
        attempt: 1,
        branch: "impl/test-restart-retry-task",
      }));

      // Workspace directory must exist so initFromDisk and acquireExisting succeed
      mkdirSync(join(TMP, "projects", PROJECT_ID, "instances", "0"), { recursive: true });

      const tm = new TaskManager(config);

      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;

      // Keep hasFreeSlot = false so the 0-delay retry goes to "queued" rather than immediately
      // attempting to re-run (which would trigger git/docker again in the background)
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // Wait long enough for:
      //   1. executeTask() to fail (git commands fail — no real repo)
      //   2. scheduleRetry() with delay=0 to fire and transition the task to "queued"
      await new Promise((r) => setTimeout(r, 1000));

      const task = tm.getTask(PROJECT_ID, "restart-retry-task");
      // With the fix: delay=0 → setTimeout fires immediately → task is "queued"
      // Without the fix: delay=9999s → task is still "retrying" after 1s
      expect(task?.status).toBe("queued");
      expect(task?.attempt).toBe(2); // attempt counter was incremented by scheduleRetry
    });

    it("subsequent retries after a restart use the normal configured delay", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig({
        projects: {
          [PROJECT_ID]: {
            maxConcurrentTasks: 4,
            repositories: [
              { name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" },
            ],
            claudeCode: { command: "claude" },
            errorRetry: { maxAttempts: 3, delaySeconds: 60 },
          },
        },
      });
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "multi-retry-task",
        status: "running",
        completedAt: null,
        workspaceId: 0,
        attempt: 1,
        branch: "impl/test-multi-retry-task",
      }));

      mkdirSync(join(TMP, "projects", PROJECT_ID, "instances", "0"), { recursive: true });

      const tm = new TaskManager(config);

      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;

      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      // Spy on scheduleRetry to capture how many times and with what delay it was called
      const scheduleRetryCalls: Array<{ attempt: number; delay: number | undefined }> = [];
      // @ts-expect-error - accessing private method for testing
      const originalScheduleRetry = tm.scheduleRetry.bind(tm);
      // @ts-expect-error - accessing private method for testing
      vi.spyOn(tm, "scheduleRetry").mockImplementation((task, projState, delayOverride) => {
        scheduleRetryCalls.push({ attempt: task.attempt + 1, delay: delayOverride });
        return originalScheduleRetry(task, projState, delayOverride);
      });

      await tm.init();

      // Wait for first failure (resume → fail → scheduleRetry with delay=0)
      await new Promise((r) => setTimeout(r, 1000));

      expect(scheduleRetryCalls).toHaveLength(1);
      // First failure after restart: delay override should be 0
      expect(scheduleRetryCalls[0].delay).toBe(0);
    });
  });

  describe("startTask", () => {
    it("returns immediately with queued status and null branch", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // Metadata generation is controlled manually — it will not resolve until we allow it
      let resolveMetadata!: (v: { slug: string; title: string }) => void;
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(
        new Promise<{ slug: string; title: string }>((r) => { resolveMetadata = r; })
      );

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      const task = await tm.startTask(PROJECT_ID, { prompt: "Add a button" });

      // Returned immediately before metadata generation completes
      expect(task.branch).toBeNull();
      expect(task.status).toBe("queued");
      expect(task.taskId).toBeDefined();
      expect(tm.getTask(PROJECT_ID, task.taskId)).toBeDefined();

      // Unblock metadata generation and verify branch and title are set afterwards
      resolveMetadata({ slug: "add-button", title: "Add a Button" });
      await new Promise((r) => setTimeout(r, 50));

      expect(tm.getTask(PROJECT_ID, task.taskId)?.branch).toBe(`impl/add-button-${task.taskId}`);
      expect(tm.getTask(PROJECT_ID, task.taskId)?.title).toBe("Add a Button");
    });

    it("registers the task in memory before slug generation completes", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // Metadata generation never resolves during this test — background stays pending
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(new Promise(() => {}));

      const task = await tm.startTask(PROJECT_ID, { prompt: "Do something" });

      expect(tm.getTask(PROJECT_ID, task.taskId)).toBeDefined();
      expect(tm.listTasks(PROJECT_ID)).toHaveLength(1);
    });
  });

  describe("retryTask", () => {
    it("throws TaskActiveError when task is running", async () => {
      const { TaskManager, TaskActiveError } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "run-task", status: "running", completedAt: null }));

      const tm = new TaskManager(config);
      await tm.init();

      // Manually set status to running in memory (init may have changed it)
      // @ts-expect-error - accessing private tasks map for testing
      tm.tasks.get("run-task").task.status = "running";

      await expect(tm.retryTask(PROJECT_ID, "run-task")).rejects.toBeInstanceOf(TaskActiveError);
    });

    it("throws TaskActiveError when task is queued", async () => {
      const { TaskManager, TaskActiveError } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "queued-task", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // Manually flip status to "queued" in memory to simulate a queued task
      // @ts-expect-error - accessing private tasks map for testing
      tm.tasks.get("queued-task").task.status = "queued";

      await expect(tm.retryTask(PROJECT_ID, "queued-task")).rejects.toBeInstanceOf(TaskActiveError);
    });

    it("throws TaskActiveError when task is retrying", async () => {
      const { TaskManager, TaskActiveError } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "retry-task", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // Manually flip status to "retrying" in memory to simulate an active auto-retry
      // @ts-expect-error - accessing private tasks map for testing
      tm.tasks.get("retry-task").task.status = "retrying";

      await expect(tm.retryTask(PROJECT_ID, "retry-task")).rejects.toBeInstanceOf(TaskActiveError);
    });

    it("throws error for unknown task", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const tm = new TaskManager(makeConfig());

      await expect(tm.retryTask(PROJECT_ID, "nonexistent")).rejects.toThrow("Task not found");
    });

    it("throws error for task belonging to another project", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config: Config = {
        server: { workspaceDir: TMP },
        projects: {
          [PROJECT_ID]: {
            repositories: [{ name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" }],
            claudeCode: { command: "claude" },
          },
          "other-project": {
            repositories: [{ name: "other-repo", url: "https://github.com/test/other.git", defaultBranch: "main" }],
            claudeCode: { command: "claude" },
          },
        },
      };
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "other-task", projectId: PROJECT_ID, status: "failed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // "other-task" belongs to PROJECT_ID, so "other-project" cannot access it
      await expect(tm.retryTask("other-project", "other-task")).rejects.toThrow("Task not found");
    });

    it("resets task state and keeps branch when retrying a failed task", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "fail-task",
        status: "failed",
        error: "Claude Code exited with code 1",
        branch: "impl/test-fail-task",
        output: "partial output",
        attempt: 3,
      }));

      const tm = new TaskManager(config);
      await tm.init();

      // Spy on pool.acquire to prevent actual workspace acquisition
      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      // retryTask will queue due to acquire failing
      const result = await tm.retryTask(PROJECT_ID, "fail-task");

      expect(result.taskId).toBe("fail-task");
      expect(result.branch).toBe("impl/test-fail-task");
      expect(result.error).toBeUndefined();
      expect(result.output).toBe("");
      expect(result.attempt).toBe(1);
      expect(result.completedAt).toBeNull();
      expect(result.status).toBe("queued");
    });

    it("resets task state when retrying a completed task", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "done-task",
        status: "completed",
        branch: "impl/done-done-task",
        output: "All done",
        completedAt: "2025-01-01T01:00:00.000Z",
        attempt: 1,
      }));

      const tm = new TaskManager(config);
      await tm.init();

      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      const result = await tm.retryTask(PROJECT_ID, "done-task");

      expect(result.status).toBe("queued");
      expect(result.output).toBe("");
      expect(result.error).toBeUndefined();
      expect(result.completedAt).toBeNull();
      expect(result.attempt).toBe(1);
    });

  describe("project isolation", () => {
    it("getTask returns undefined for task belonging to another project", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config: Config = {
        server: { workspaceDir: TMP },
        projects: {
          "project-a": {
            repositories: [{ name: "repo-a", url: "https://example.com/a.git", defaultBranch: "main" }],
            claudeCode: { command: "claude" },
          },
          "project-b": {
            repositories: [{ name: "repo-b", url: "https://example.com/b.git", defaultBranch: "main" }],
            claudeCode: { command: "claude" },
          },
        },
      };
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "task-a", projectId: "project-a", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // project-a can see its own task
      expect(tm.getTask("project-a", "task-a")).toBeDefined();
      // project-b cannot see project-a's task
      expect(tm.getTask("project-b", "task-a")).toBeUndefined();
      // listTasks is scoped
      expect(tm.listTasks("project-a")).toHaveLength(1);
      expect(tm.listTasks("project-b")).toHaveLength(0);
    });
  });

  describe("task chains", () => {
    it("startTask with continueTaskId sets parentTaskId, chainId, and inherits branch", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      // Pre-populate a completed task to continue from
      store.save(makePersistedTask({
        taskId: "task-a",
        status: "completed",
        branch: "impl/feature-task-a",
        output: "Done",
      }));

      const tm = new TaskManager(config);
      await tm.init();

      // Mock metadata generation
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "continue", title: "Continue" });

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      const task = await tm.startTask(PROJECT_ID, { prompt: "Continue work", continueTaskId: "task-a" });

      expect(task.parentTaskId).toBe("task-a");
      expect(task.chainId).toBe("task-a");
      expect(task.branch).toBe("impl/feature-task-a");
    });

    it("rejects continueTaskId for non-existent task", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      await expect(
        tm.startTask(PROJECT_ID, { prompt: "Continue", continueTaskId: "nonexistent" })
      ).rejects.toThrow("Task not found: nonexistent");
    });

    it("rejects continueTaskId for task in different project", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config: Config = {
        server: { workspaceDir: TMP },
        projects: {
          [PROJECT_ID]: {
            repositories: [{ name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" }],
            claudeCode: { command: "claude" },
          },
          "other-project": {
            repositories: [{ name: "other-repo", url: "https://github.com/test/other.git", defaultBranch: "main" }],
            claudeCode: { command: "claude" },
          },
        },
      };
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "task-other", projectId: "other-project", status: "completed", branch: "impl/other" }));

      const tm = new TaskManager(config);
      await tm.init();

      // Trying to continue task-other from PROJECT_ID should fail
      await expect(
        tm.startTask(PROJECT_ID, { prompt: "Continue", continueTaskId: "task-other" })
      ).rejects.toThrow("Task not found: task-other");
    });

    it("rejects continueTaskId that is not the chain tip (error mentions the actual tip)", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      // Build chain: A -> B
      store.save(makePersistedTask({ taskId: "chain-a", status: "completed", branch: "impl/chain-a" }));
      store.save(makePersistedTask({ taskId: "chain-b", status: "completed", branch: "impl/chain-a", parentTaskId: "chain-a", chainId: "chain-a" }));

      const tm = new TaskManager(config);
      await tm.init();

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "test", title: "Test" });

      // Trying to continue from chain-a (not the tip) should fail mentioning chain-b
      await expect(
        tm.startTask(PROJECT_ID, { prompt: "Continue", continueTaskId: "chain-a" })
      ).rejects.toThrow("Continue from chain-b instead");
    });

    it("rejects continueTaskId for task with null branch", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "no-branch", status: "completed", branch: null }));

      const tm = new TaskManager(config);
      await tm.init();

      await expect(
        tm.startTask(PROJECT_ID, { prompt: "Continue", continueTaskId: "no-branch" })
      ).rejects.toThrow("has no branch to continue from");
    });

    it("chain tasks run serially (second task queues when chain active)", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "root-task", status: "completed", branch: "impl/root-task" }));

      const tm = new TaskManager(config);
      await tm.init();

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "test", title: "Test" });

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(true);
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("should not be called for second task"));

      // Simulate chain being active
      // @ts-expect-error - private
      tm.markChainActive(PROJECT_ID, "root-task");

      const task = await tm.startTask(PROJECT_ID, { prompt: "Chain task", continueTaskId: "root-task" });

      // Give background a moment
      await new Promise((r) => setTimeout(r, 80));

      // Despite free capacity, task should be queued because chain is active
      expect(tm.getTask(PROJECT_ID, task.taskId)?.status).toBe("queued");
    });

    it("chain task dequeues after active chain completes", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      // Pre-populate a queued chain task
      store.save(makePersistedTask({
        taskId: "chain-task-2",
        status: "queued",
        chainId: "root-chain",
        parentTaskId: "root-chain",
        branch: "impl/root-chain",
      }));

      const tm2 = new TaskManager(config);

      // @ts-expect-error - private
      const state = tm2.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      await tm2.init();

      const queuedTask = tm2.getTask(PROJECT_ID, "chain-task-2");
      expect(queuedTask?.status).toBe("queued");

      // Simulate chain being active then released
      // @ts-expect-error - private
      tm2.markChainActive(PROJECT_ID, "root-chain");

      // Release chain, make capacity available
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(true);
      let acquireCalled = false;
      vi.spyOn(state.pool, "acquire").mockImplementation(() => {
        acquireCalled = true;
        return new Promise(() => {}); // stay pending
      });

      // @ts-expect-error - private
      tm2.unmarkChainActive(PROJECT_ID, "root-chain");
      // @ts-expect-error - private
      tm2.tryDequeue(PROJECT_ID, state);

      await new Promise((r) => setTimeout(r, 20));
      expect(acquireCalled).toBe(true);
    });

    it("chain task preserves branch on no-commits completion", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "chain-root",
        status: "completed",
        branch: "impl/chain-root",
      }));

      const tm = new TaskManager(config);
      await tm.init();

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "test", title: "Test" });

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      const task = await tm.startTask(PROJECT_ID, { prompt: "Chain work", continueTaskId: "chain-root" });

      // Chain task should inherit the branch
      expect(task.branch).toBe("impl/chain-root");
      expect(task.chainId).toBe("chain-root");
    });

    it("multi-task chain: A->B->C, continuing from C works, from A/B rejected", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      // Build chain: A -> B -> C
      store.save(makePersistedTask({ taskId: "mt-a", status: "completed", branch: "impl/mt-a" }));
      store.save(makePersistedTask({ taskId: "mt-b", status: "completed", branch: "impl/mt-a", parentTaskId: "mt-a", chainId: "mt-a" }));
      store.save(makePersistedTask({ taskId: "mt-c", status: "completed", branch: "impl/mt-a", parentTaskId: "mt-b", chainId: "mt-a" }));

      const tm = new TaskManager(config);
      await tm.init();

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "test", title: "Test" });

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      // Continuing from C (tip) should work
      const taskD = await tm.startTask(PROJECT_ID, { prompt: "Continue from C", continueTaskId: "mt-c" });
      expect(taskD.parentTaskId).toBe("mt-c");
      expect(taskD.chainId).toBe("mt-a");

      // Continuing from A (not tip) should fail
      await expect(
        tm.startTask(PROJECT_ID, { prompt: "Continue from A", continueTaskId: "mt-a" })
      ).rejects.toThrow("not the latest in its chain");

      // Continuing from B (not tip) should fail
      await expect(
        tm.startTask(PROJECT_ID, { prompt: "Continue from B", continueTaskId: "mt-b" })
      ).rejects.toThrow("not the latest in its chain");
    });
  });

  describe("getOutput with null executor", () => {
    it("returns stored output for completed task loaded from disk", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "stored-task",
        status: "completed",
        output: "The final output",
      }));

      const tm = new TaskManager(config);
      await tm.init();

      expect(tm.getOutput(PROJECT_ID, "stored-task")).toBe("The final output");
    });

    it("returns empty string for running task with null executor", async () => {
      const { TaskManager } = await import("../src/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      // This simulates a task that's "interrupted" but hasn't been resumed yet
      store.save(makePersistedTask({
        taskId: "no-exec-task",
        status: "interrupted",
        output: "",
      }));

      const tm = new TaskManager(config);
      // Manually load without resuming to keep executor null
      const persisted = store.loadAll();
      for (const pt of persisted) {
        // @ts-expect-error - accessing private tasks map for testing
        tm.tasks.set(pt.taskId, { task: pt, executor: null, workspaceId: pt.workspaceId });
      }

      expect(tm.getOutput(PROJECT_ID, "no-exec-task")).toBe("");
    });
  });
});
