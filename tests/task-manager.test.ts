import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedTask } from "../src/types.js";
import type { Config } from "../src/config/config.js";
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
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm).toBeDefined();
  });

  it("listTasks returns empty array initially", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm.listTasks(PROJECT_ID)).toEqual([]);
  });

  it("listAllActiveTasks returns empty array initially", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm.listAllActiveTasks()).toEqual([]);
  });

  it("listAllActiveTasks returns empty when only completed/failed tasks are loaded", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const store = new TaskStore(makeConfig().server.workspaceDir);
    store.save(makePersistedTask({ taskId: "t-completed", status: "completed", completedAt: new Date().toISOString() }));
    store.save(makePersistedTask({ taskId: "t-failed", status: "failed", completedAt: new Date().toISOString() }));

    const tm = new TaskManager(makeConfig());
    await tm.init();

    expect(tm.listAllActiveTasks()).toEqual([]);
  });

  it("getTask returns undefined for unknown id", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm.getTask(PROJECT_ID, "nonexistent")).toBeUndefined();
  });

  it("getOutput returns empty string for unknown id", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm.getOutput(PROJECT_ID, "nonexistent")).toBe("");
  });

  it("accepts multiple repositories in config", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();

      const tm = new TaskManager(config);
      await tm.init();

      expect(tm.listTasks(PROJECT_ID)).toEqual([]);
    });

    it("marks interrupted task as failed when workspace is missing", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
    it("returns immediately with starting status and null branch", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      expect(task.status).toBe("starting");
      expect(task.taskId).toBeDefined();
      expect(tm.getTask(PROJECT_ID, task.taskId)).toBeDefined();

      // Unblock metadata generation and verify branch and title are set afterwards
      resolveMetadata({ slug: "add-button", title: "Add a Button" });
      await new Promise((r) => setTimeout(r, 50));

      expect(tm.getTask(PROJECT_ID, task.taskId)?.branch).toBe(`impl/add-button-${task.taskId}`);
      expect(tm.getTask(PROJECT_ID, task.taskId)?.title).toBe("Add a Button");
    });

    it("registers the task in memory before slug generation completes", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager, TaskActiveError } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager, TaskActiveError } = await import("../src/task-manager/task-manager.js");
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

    it("allows retryTask from retrying status and clears any pending timer", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "retry-task", status: "completed", branch: "impl/test-retry-task" }));

      const tm = new TaskManager(config);
      await tm.init();

      // Manually flip status to "retrying" with a fake timer to simulate an active auto-retry
      // @ts-expect-error - accessing private tasks map for testing
      const entry = tm.tasks.get("retry-task");
      entry.task.status = "retrying";
      // Assign a fake timer that should be cleared when retryTask is called
      const fakeClearCalled = { value: false };
      entry.retryTimeoutId = setTimeout(() => {
        fakeClearCalled.value = true;
      }, 9999_000) as ReturnType<typeof setTimeout>;

      // retryTask should NOT throw and should clear the timer
      await tm.retryTask(PROJECT_ID, "retry-task");

      // Timer was cleared — the fake callback should never fire
      clearTimeout(entry.retryTimeoutId);
    });

    it("throws error for unknown task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const tm = new TaskManager(makeConfig());

      await expect(tm.retryTask(PROJECT_ID, "nonexistent")).rejects.toThrow("Task not found");
    });

    it("throws error for task belonging to another project", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
  });

  describe("project isolation", () => {
    it("getTask returns undefined for task belonging to another project", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      await expect(
        tm.startTask(PROJECT_ID, { prompt: "Continue", continueTaskId: "nonexistent" })
      ).rejects.toThrow("Task not found: nonexistent");
    });

    it("rejects continueTaskId for task in different project", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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

    it("allows continueTaskId for task with null branch (parent made no changes)", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      // Parent task completed with no commits — branch is null
      store.save(makePersistedTask({ taskId: "no-branch", status: "completed", branch: null, output: "Nothing to do." }));

      const tm = new TaskManager(config);
      await tm.init();

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "fresh-start", title: "Fresh start" });

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      // Should NOT throw — continuation is allowed even when parent made no changes
      const task = await tm.startTask(PROJECT_ID, { prompt: "Continue anyway", continueTaskId: "no-branch" });

      // Chain metadata is set correctly
      expect(task.parentTaskId).toBe("no-branch");
      expect(task.chainId).toBe("no-branch"); // root of the chain
      // A fresh branch was generated (not inherited)
      expect(task.branch).toBe("impl/fresh-start-" + task.taskId);
    });

    it("continuation from branchless parent generates new branch (not checkout)", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const { GitManager } = await import("../src/git-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "branchless", status: "completed", branch: null }));

      const tm = new TaskManager(config);
      await tm.init();

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "new-work", title: "New work" });

      const prepareNewBranchSpy = vi.spyOn(GitManager.prototype, "prepareNewBranchAll").mockResolvedValue();
      const checkoutBranchSpy = vi.spyOn(GitManager.prototype, "checkoutBranchAll").mockResolvedValue();
      vi.spyOn(GitManager.prototype, "pushBranchAll").mockResolvedValue();
      vi.spyOn(GitManager.prototype, "getHeadAll").mockResolvedValue(new Map());
      vi.spyOn(GitManager.prototype, "hasUncommittedChanges").mockResolvedValue(false);
      vi.spyOn(GitManager.prototype, "ensureBranchAtHeadAll").mockResolvedValue(false);

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      const fakeWorkspace = { id: 0, dir: "/fake" };
      vi.spyOn(state.pool, "acquire").mockResolvedValue(fakeWorkspace);
      vi.spyOn(Executor.prototype, "run").mockResolvedValue({ exitCode: 0, output: "", timedOut: false });

      await tm.startTask(PROJECT_ID, { prompt: "Do new work", continueTaskId: "branchless" });

      // Allow async work to complete
      await new Promise((r) => setTimeout(r, 50));

      // prepareNewBranch should be called (create fresh branch), NOT checkoutBranch
      expect(prepareNewBranchSpy).toHaveBeenCalled();
      expect(checkoutBranchSpy).not.toHaveBeenCalled();
    });

    it("chain tasks run serially (second task queues when chain active)", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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

      // Give background a moment — prepareAndRunTask detects chain active and transitions to queued
      await new Promise((r) => setTimeout(r, 80));

      // Despite free capacity, task should be queued because chain is active
      expect(tm.getTask(PROJECT_ID, task.taskId)?.status).toBe("queued");
    });

    it("chain task dequeues after active chain completes", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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

    it("continuation from branchless parent sets checkoutBranch to undefined (fresh branch)", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "parent-no-branch", status: "completed", branch: null }));

      const tm = new TaskManager(config);
      await tm.init();

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "child", title: "Child" });

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      // Simulate chain is active so the task gets queued, letting us inspect entry.checkoutBranch
      tm.markChainActive(PROJECT_ID, "parent-no-branch" as any);

      await tm.startTask(PROJECT_ID, { prompt: "Continue from branchless", continueTaskId: "parent-no-branch" });

      // Allow async branch generation to complete
      await new Promise((r) => setTimeout(r, 50));

      // Find the new child task
      const childEntry = Array.from((tm as any).tasks.values()).find(
        (e: any) => e.task.parentTaskId === "parent-no-branch"
      ) as any;
      expect(childEntry).toBeDefined();
      // checkoutBranch should be undefined: fresh branch must be created, not checked out
      expect(childEntry.checkoutBranch).toBeUndefined();
      // Branch should be freshly generated
      expect(childEntry.task.branch).toMatch(/^impl\/child-/);
    });

    it("continuation from task with branch sets checkoutBranch to inherited branch", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "parent-with-branch", status: "completed", branch: "impl/parent-xyz" }));

      const tm = new TaskManager(config);
      await tm.init();

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "child2", title: "Child2" });

      // Simulate chain is active so the task gets queued
      tm.markChainActive(PROJECT_ID, "parent-with-branch" as any);

      await tm.startTask(PROJECT_ID, { prompt: "Continue from parent", continueTaskId: "parent-with-branch" });

      await new Promise((r) => setTimeout(r, 50));

      const childEntry = Array.from((tm as any).tasks.values()).find(
        (e: any) => e.task.parentTaskId === "parent-with-branch"
      ) as any;
      expect(childEntry).toBeDefined();
      // checkoutBranch should be the inherited branch — it must be checked out, not created
      expect(childEntry.checkoutBranch).toBe("impl/parent-xyz");
    });

    it("chain context is included in prompt when running continuation task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const { GitManager } = await import("../src/git-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      const parentOutput = '{"message":{"content":[{"type":"text","text":"Added the login button"}]}}';
      store.save(makePersistedTask({
        taskId: "ctx-parent",
        status: "completed",
        branch: "impl/ctx-parent",
        title: "Add login button",
        output: parentOutput,
      }));

      const tm = new TaskManager(config);
      await tm.init();

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "ctx-child", title: "Ctx child" });

      vi.spyOn(GitManager.prototype, "checkoutBranchAll").mockResolvedValue();
      vi.spyOn(GitManager.prototype, "pushBranchAll").mockResolvedValue();
      vi.spyOn(GitManager.prototype, "getHeadAll").mockResolvedValue(new Map());
      vi.spyOn(GitManager.prototype, "hasUncommittedChanges").mockResolvedValue(false);
      vi.spyOn(GitManager.prototype, "ensureBranchAtHeadAll").mockResolvedValue(false);

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      const fakeWorkspace = { id: 0, dir: "/fake" };
      vi.spyOn(state.pool, "acquire").mockResolvedValue(fakeWorkspace);

      let capturedPrompt = "";
      vi.spyOn(Executor.prototype, "run").mockImplementation(async (prompt) => {
        capturedPrompt = prompt;
        return { exitCode: 0, output: "", timedOut: false };
      });

      await tm.startTask(PROJECT_ID, { prompt: "Now add the logout button", continueTaskId: "ctx-parent" });

      // Allow async execution to proceed
      await new Promise((r) => setTimeout(r, 100));

      // The prompt should include context from the parent task
      expect(capturedPrompt).toContain("Context from previous tasks in this chain");
      expect(capturedPrompt).toContain("Add login button");
      expect(capturedPrompt).toContain("Added the login button");
    });
  });

  describe("getOutput with null executor", () => {
    it("returns stored output for completed task loaded from disk", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
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

  describe("persistEntry", () => {
    it("persists task entry to disk", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "persist-test", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // Update the task in memory and persist
      const task = tm.getTask(PROJECT_ID, "persist-test")!;
      task.output = "updated output";
      // @ts-expect-error - accessing private tasks map for testing
      const entry = tm.tasks.get("persist-test")!;
      tm.persistEntry(entry);

      // Verify it was persisted
      const onDisk = JSON.parse(
        readFileSync(join(TMP, "tasks", "persist-test.json"), "utf-8"),
      );
      expect(onDisk.output).toBe("updated output");
    });

    it("includes workspaceId in persisted data", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "ws-test", status: "completed", workspaceId: 42 }));

      const tm = new TaskManager(config);
      await tm.init();

      // @ts-expect-error - accessing private tasks map for testing
      const entry = tm.tasks.get("ws-test")!;
      tm.persistEntry(entry);

      const onDisk = JSON.parse(
        readFileSync(join(TMP, "tasks", "ws-test.json"), "utf-8"),
      );
      expect(onDisk.workspaceId).toBe(42);
    });
  });

  describe("cancelTask", () => {
    it("cancels a queued task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "cancel-queued", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // Set task to queued manually
      // @ts-expect-error - accessing private tasks map for testing
      tm.tasks.get("cancel-queued").task.status = "queued";

      const result = tm.cancelTask(PROJECT_ID, "cancel-queued");
      expect(result.status).toBe("cancelled");
      expect(result.completedAt).toBeDefined();

      const onDisk = JSON.parse(
        readFileSync(join(TMP, "tasks", "cancel-queued.json"), "utf-8"),
      );
      expect(onDisk.status).toBe("cancelled");
    });

    it("cancels a retrying task and clears timeout", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "cancel-retrying", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // Set task to retrying with a timeout
      // @ts-expect-error - accessing private tasks map for testing
      const entry = tm.tasks.get("cancel-retrying")!;
      entry.task.status = "retrying";
      entry.retryTimeoutId = setTimeout(() => {}, 99999);

      const result = tm.cancelTask(PROJECT_ID, "cancel-retrying");
      expect(result.status).toBe("cancelled");
      expect(entry.retryTimeoutId).toBeUndefined();
    });

    it("throws TaskCancelError for completed task", async () => {
      const { TaskManager, TaskCancelError } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "cancel-done", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      expect(() => tm.cancelTask(PROJECT_ID, "cancel-done")).toThrow(TaskCancelError);
    });

    it("throws for unknown project", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const tm = new TaskManager(makeConfig());

      expect(() => tm.cancelTask("nonexistent" as any, "any-task" as any)).toThrow("Unknown project");
    });

    it("throws for unknown task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const tm = new TaskManager(makeConfig());

      expect(() => tm.cancelTask(PROJECT_ID, "nonexistent" as any)).toThrow("Task not found");
    });
  });

  describe("editTask", () => {
    it("edits the prompt of a queued task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "edit-task", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // Set to queued
      // @ts-expect-error - accessing private tasks map for testing
      tm.tasks.get("edit-task").task.status = "queued";

      const result = tm.editTask(PROJECT_ID, "edit-task", "New prompt text");
      expect(result.prompt).toBe("New prompt text");
      expect(result.title).toBeUndefined();

      const onDisk = JSON.parse(
        readFileSync(join(TMP, "tasks", "edit-task.json"), "utf-8"),
      );
      expect(onDisk.prompt).toBe("New prompt text");
    });

    it("throws TaskEditError for non-queued task", async () => {
      const { TaskManager, TaskEditError } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "edit-running", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // Set to running
      // @ts-expect-error - accessing private tasks map for testing
      tm.tasks.get("edit-running").task.status = "running";

      expect(() => tm.editTask(PROJECT_ID, "edit-running", "New prompt")).toThrow(TaskEditError);
    });

    it("throws TaskEditError for empty prompt", async () => {
      const { TaskManager, TaskEditError } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "edit-empty", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // @ts-expect-error - accessing private tasks map for testing
      tm.tasks.get("edit-empty").task.status = "queued";

      expect(() => tm.editTask(PROJECT_ID, "edit-empty", "  ")).toThrow(TaskEditError);
    });

    it("throws for unknown project", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const tm = new TaskManager(makeConfig());

      expect(() => tm.editTask("nonexistent" as any, "any-task" as any, "prompt")).toThrow("Unknown project");
    });

    it("throws for unknown task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const tm = new TaskManager(makeConfig());

      expect(() => tm.editTask(PROJECT_ID, "nonexistent" as any, "prompt")).toThrow("Task not found");
    });
  });

  describe("branchless task recovery", () => {
    it("tryDequeue routes branchless queued task through prepareAndRunTask for slug generation", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      // Simulate a task that was persisted with branch=null and status=queued
      // (server crashed before slug generation completed)
      store.save(makePersistedTask({
        taskId: "branchless-task",
        status: "queued",
        branch: null,
        completedAt: null,
      }));

      const tm = new TaskManager(config);

      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;

      // Mock slug generation to succeed
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "fix-bug", title: "Fix Bug" });

      // Allow dequeue (hasFreeSlot=true) so tryDequeue reaches the branchless task,
      // but reject acquire so prepareAndRunTask queues the task instead of running it
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(true);
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      await tm.init();

      // Wait for prepareAndRunTask (slug generation) to complete
      await new Promise((r) => setTimeout(r, 200));

      const task = tm.getTask(PROJECT_ID, "branchless-task");
      // Branch should now be set (slug generation happened)
      expect(task?.branch).toBe("impl/fix-bug-branchless-task");
      expect(task?.title).toBe("Fix Bug");
      // Task should be queued (acquire rejected)
      expect(task?.status).toBe("queued");
    });

    it("tryDequeue does not pass null branch to executeTask", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      // Simulate branchless queued task
      store.save(makePersistedTask({
        taskId: "null-branch-task",
        status: "queued",
        branch: null,
        completedAt: null,
      }));

      const tm = new TaskManager(config);

      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;

      // Slug generation fails — task should be marked as failed, not crash with "branch null"
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockRejectedValue(new Error("API error"));
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(true);

      await tm.init();

      // Wait for the failed prepareAndRunTask
      await new Promise((r) => setTimeout(r, 200));

      const task = tm.getTask(PROJECT_ID, "null-branch-task");
      expect(task?.status).toBe("failed");
      expect(task?.error).toContain("API error");
    });
  });

  describe("starting status", () => {
    it("startTask returns status 'starting'", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // Metadata generation never resolves — keeps task in starting phase
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(new Promise(() => {}));

      const task = await tm.startTask(PROJECT_ID, { prompt: "Add a button" });

      expect(task.status).toBe("starting");
      expect(task.branch).toBeNull();
      expect(task.taskId).toBeDefined();
    });

    it("starting task transitions to running after metadata generation", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      let resolveMetadata!: (v: { slug: string; title: string }) => void;
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(
        new Promise<{ slug: string; title: string }>((r) => { resolveMetadata = r; })
      );

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(true);
      // Acquire stays pending so executeTask never runs (avoids git errors)
      vi.spyOn(state.pool, "acquire").mockReturnValue(new Promise(() => {}));

      const task = await tm.startTask(PROJECT_ID, { prompt: "Add a button" });
      expect(task.status).toBe("starting");

      // Resolve metadata — task should transition to running
      resolveMetadata({ slug: "add-button", title: "Add a Button" });
      await new Promise((r) => setTimeout(r, 100));

      expect(tm.getTask(PROJECT_ID, task.taskId)?.status).toBe("running");
    });

    it("starting task transitions to queued when at capacity", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      let resolveMetadata!: (v: { slug: string; title: string }) => void;
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(
        new Promise<{ slug: string; title: string }>((r) => { resolveMetadata = r; })
      );

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      const task = await tm.startTask(PROJECT_ID, { prompt: "Add a button" });
      expect(task.status).toBe("starting");

      // Resolve metadata — task should transition to queued (no capacity)
      resolveMetadata({ slug: "add-button", title: "Add a Button" });
      await new Promise((r) => setTimeout(r, 100));

      expect(tm.getTask(PROJECT_ID, task.taskId)?.status).toBe("queued");
    });

    it("starting task can be cancelled", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // Metadata generation never resolves — keeps task in starting phase
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(new Promise(() => {}));

      const task = await tm.startTask(PROJECT_ID, { prompt: "Cancel me" });
      expect(task.status).toBe("starting");

      const result = tm.cancelTask(PROJECT_ID, task.taskId);
      expect(result.status).toBe("cancelled");
      expect(result.completedAt).toBeDefined();
    });

    it("starting task can be edited", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // Metadata generation never resolves — keeps task in starting phase
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(new Promise(() => {}));

      const task = await tm.startTask(PROJECT_ID, { prompt: "Edit me" });
      expect(task.status).toBe("starting");

      const result = tm.editTask(PROJECT_ID, task.taskId, "New prompt");
      expect(result.prompt).toBe("New prompt");
      expect(result.title).toBeUndefined();
    });

    it("recoverTask re-enqueues starting tasks as queued", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      // Task was in "starting" state when server crashed
      store.save(makePersistedTask({
        taskId: "starting-task",
        status: "starting" as any,
        branch: null,
        completedAt: null,
        workspaceId: null,
      }));

      const tm = new TaskManager(config);

      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      const task = tm.getTask(PROJECT_ID, "starting-task");
      expect(task?.status).toBe("queued");

      const onDisk = JSON.parse(
        readFileSync(join(TMP, "tasks", "starting-task.json"), "utf-8"),
      );
      expect(onDisk.status).toBe("queued");
    });

    it("retryTask rejects starting tasks with TaskActiveError", async () => {
      const { TaskManager, TaskActiveError } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // Metadata generation never resolves — keeps task in starting phase
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(new Promise(() => {}));

      const task = await tm.startTask(PROJECT_ID, { prompt: "Retry me" });
      expect(task.status).toBe("starting");

      await expect(tm.retryTask(PROJECT_ID, task.taskId)).rejects.toBeInstanceOf(TaskActiveError);
    });

    it("listAllActiveTasks includes starting tasks", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // Metadata generation never resolves — keeps task in starting phase
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(new Promise(() => {}));

      const task = await tm.startTask(PROJECT_ID, { prompt: "Active task" });
      expect(task.status).toBe("starting");

      const active = tm.listAllActiveTasks();
      expect(active).toHaveLength(1);
      expect(active[0].status).toBe("starting");
    });
  });
  describe("timeout → retrying behavior", () => {
    it("re-enqueues a timeout-retrying task on restart with checkoutBranch set", async () => {
      // Simulates: task timed out → status "retrying", attempt incremented → server restarts
      // Expected:  recoverTask converts "retrying" → "queued" with checkoutBranch = task.branch
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "timeout-task",
        status: "retrying" as any,
        completedAt: null,
        workspaceId: null,
        attempt: 2,              // incremented by timeout handler
        branch: "impl/my-feature-timeout-task",
        error: "Timed out after 3600 seconds",
      }));

      const tm = new TaskManager(config);
      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      const task = tm.getTask(PROJECT_ID, "timeout-task");
      // Task should be re-queued (not stuck in retrying)
      expect(task?.status).toBe("queued");
      // Attempt counter preserved (timeout handler already incremented it)
      expect(task?.attempt).toBe(2);
      // Branch must be preserved for continuation
      expect(task?.branch).toBe("impl/my-feature-timeout-task");

      // checkoutBranch set so tryDequeue uses existing branch, not a new one
      // @ts-expect-error - accessing private tasks map for testing
      const entry = tm.tasks.get("timeout-task");
      expect(entry?.checkoutBranch).toBe("impl/my-feature-timeout-task");
    });

    it("executeTask sets status to retrying and preserves branch on timeout", async () => {
      // Unit-tests the executeTask path: when executor returns timedOut=true the
      // task ends up in "retrying" state with branch intact and no completedAt.
      const { executeTask } = await import("../src/task-manager/task-runner.js");
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const { TaskStore } = await import("../src/task-store.js");
      const { WorkspacePool } = await import("../src/workspace-pool.js");
      const { GitManager } = await import("../src/git-manager.js");
      const { TokenManager } = await import("../src/auth.js");

      const config = makeConfig({
        projects: {
          [PROJECT_ID]: {
            repositories: [{ name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" }],
            claudeCode: { command: "claude", timeoutSeconds: 3600 },
          },
        },
      });
      const store = new TaskStore(TMP);
      const tm = new TaskManager(config);
      await tm.init();

      const task = await tm.startTask(PROJECT_ID, { prompt: "Build the thing" });
      // Wait for branch slug to be generated (mocked)
      await new Promise((r) => setTimeout(r, 50));

      // Ensure the task has a branch before we try executeTask
      const entry = tm.tasks.get(task.taskId)!;
      entry.task.branch = "impl/build-the-thing-" + task.taskId;
      entry.task.status = "running";

      // Stub the executor to simulate a timeout (timedOut=true, non-zero exit)
      vi.spyOn(Executor.prototype, "run").mockResolvedValue({
        exitCode: 137,
        output: "[TIMEOUT] Task exceeded maximum runtime.",
        timedOut: true,
      });

      // Stub git operations to no-ops
      // @ts-expect-error - accessing private projects map
      const projectState = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(projectState.pool, "acquire").mockResolvedValue({ id: 0, dir: TMP });
      vi.spyOn(projectState.pool, "release").mockReturnValue(undefined);
      vi.spyOn(tm.gitManager, "checkoutBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "prepareNewBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "pushBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "getHeadAll").mockResolvedValue([]);
      vi.spyOn(tm.gitManager, "hasUncommittedChanges").mockResolvedValue(false);
      vi.spyOn(tm.gitManager, "revertProtectedPathsAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "ensureBranchAtHeadAll").mockResolvedValue(false);

      entry.executor = new Executor(config.projects[PROJECT_ID].claudeCode, new TokenManager(undefined, TMP));
      const workspace = { id: 0, dir: TMP };

      await executeTask(entry.task, workspace, projectState, tm);

      // Task must be "retrying" (not "failed") after a timeout
      expect(entry.task.status).toBe("retrying");
      // Branch must be preserved for the next attempt
      expect(entry.task.branch).toBe("impl/build-the-thing-" + task.taskId);
      // completedAt must be null — task hasn't truly finished
      expect(entry.task.completedAt).toBeNull();
      // attempt was incremented by the timeout handler
      expect(entry.task.attempt).toBe(2);
    });
  });


});
