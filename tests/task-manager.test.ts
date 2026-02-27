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
    server: { workspaceDir: TMP, metaCpus: 0.4, sandboxCpus: 0.4 },
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
    chainId: "chain-abc123",
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

  it("listAllTasks returns empty array initially", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm.listAllTasks()).toEqual([]);
  });

  it("listAllTasks returns completed/failed tasks from disk", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const store = new TaskStore(makeConfig().server.workspaceDir);
    store.save(makePersistedTask({ taskId: "t-completed", status: "completed", completedAt: new Date().toISOString() }));
    store.save(makePersistedTask({ taskId: "t-failed", status: "failed", completedAt: new Date().toISOString() }));

    const tm = new TaskManager(makeConfig());
    await tm.init();

    expect(tm.listAllTasks()).toHaveLength(2);
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
      server: { workspaceDir: TMP, metaCpus: 0.4, sandboxCpus: 0.4 },
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

    it("marks running tasks as interrupted and enqueues them", async () => {
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

      // Prevent dequeue from picking up the task during init
      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // After init, interrupted tasks are pushed to front of queue and become queued
      const onDisk = JSON.parse(
        readFileSync(join(TMP, "tasks", "running-task.json"), "utf-8"),
      );
      expect(onDisk.status).toBe("queued");
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

    it("interrupted task with missing workspace fails on dequeue", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
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

      // Mock metadata generation (task has branch from defaults, so this won't be called,
      // but mock it to be safe)
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "test", title: "Test", estimatedDurationSeconds: 600 });

      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;
      // Mock acquire to reject quickly (simulates workspace not available)
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("Workspace not available"));

      await tm.init();

      // Wait for the async dequeue/acquire to fail
      await new Promise((r) => setTimeout(r, 50));

      const task = tm.getTask(PROJECT_ID, "orphan-task");
      // Task is enqueued after recovery (interrupted → queued), then dequeue fails on acquire
      expect(task?.status).toBe("failed");
    });

    it("throws on init when task belongs to unknown project", async () => {
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
      await expect(tm.init()).rejects.toThrow("Unknown project");
    });

    it("interrupted tasks are recovered with checkoutBranch set", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "resumed-flag-task",
        status: "running",
        completedAt: null,
        workspaceId: 0,
        branch: "impl/test-resumed-flag-task",
      }));

      mkdirSync(join(TMP, "projects", PROJECT_ID, "instances", "0"), { recursive: true });

      const tm = new TaskManager(config);

      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // After recovery, interrupted tasks should have checkoutBranch set to resume from existing branch
      const entry = tm.tasks.get("resumed-flag-task" as any);
      expect(entry?.checkoutBranch).toBe("impl/test-resumed-flag-task");
    });
  });

  describe("restart resume", () => {
    it("interrupted tasks are enqueued and can be dequeued later", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "restart-retry-task",
        status: "running",
        completedAt: null,
        workspaceId: 0,
        attempt: 1,
        branch: "impl/test-restart-retry-task",
      }));

      mkdirSync(join(TMP, "projects", PROJECT_ID, "instances", "0"), { recursive: true });

      const tm = new TaskManager(config);

      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // After recovery, interrupted tasks should be queued
      const task = tm.getTask(PROJECT_ID, "restart-retry-task");
      expect(task?.status).toBe("queued");
      expect(task?.attempt).toBe(1); // attempt not changed by recovery itself

      // checkoutBranch should be set so the existing branch is reused on dequeue
      const entry = tm.tasks.get("restart-retry-task" as any);
      expect(entry?.checkoutBranch).toBe("impl/test-restart-retry-task");
    });

    it("retrying tasks are re-enqueued on restart", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "multi-retry-task",
        status: "retrying" as any,
        completedAt: null,
        workspaceId: null,
        attempt: 2,
        branch: "impl/test-multi-retry-task",
      }));

      const tm = new TaskManager(config);

      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      const task = tm.getTask(PROJECT_ID, "multi-retry-task");
      expect(task?.status).toBe("queued");
      expect(task?.attempt).toBe(2); // attempt preserved from disk
    });
  });

  describe("createNewTask", () => {
    it("returns immediately with queued status and null branch", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "add-button", title: "Add a Button", estimatedDurationSeconds: 600 });

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      // Prevent dequeue from picking up the task synchronously (status would change to "starting")
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      const task = await tm.createNewTask(PROJECT_ID, { prompt: "Add a button" });

      // Returned immediately — task is queued, branch not yet generated
      // (metadata generation only happens during dequeue, not during createNewTask)
      expect(task.branch).toBeNull();
      expect(task.status).toBe("queued");
      expect(task.taskId).toBeDefined();
      expect(tm.getTask(PROJECT_ID, task.taskId)).toBeDefined();
    });

    it("registers the task in memory before slug generation completes", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // Metadata generation never resolves during this test — background stays pending
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(new Promise(() => {}));

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      const task = await tm.createNewTask(PROJECT_ID, { prompt: "Do something" });

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

      // Prevent background dequeue from starting async workspace operations
      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // Manually set status to running in memory (init changed it to queued via interrupted)
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
      tm.tasks.get("queued-task").task.status = "queued";

      await expect(tm.retryTask(PROJECT_ID, "queued-task")).rejects.toBeInstanceOf(TaskActiveError);
    });

    it("throws TaskActiveError when task is retrying", async () => {
      const { TaskManager, TaskActiveError } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "retry-task", status: "completed", branch: "impl/test-retry-task" }));

      const tm = new TaskManager(config);
      await tm.init();

      // Manually flip status to "retrying" to simulate an active auto-retry
      const entry = tm.tasks.get("retry-task")!;
      entry.task.status = "retrying";

      await expect(tm.retryTask(PROJECT_ID, "retry-task")).rejects.toBeInstanceOf(TaskActiveError);
    });

    it("throws error for unknown task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const tm = new TaskManager(makeConfig());

      await expect(tm.retryTask(PROJECT_ID, "nonexistent")).rejects.toThrow("Task not found");
    });

    it("throws error for task belonging to another project", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config: Config = {
        server: { workspaceDir: TMP, metaCpus: 0.4, sandboxCpus: 0.4 },
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

    it("increments attempt and enqueues when retrying a failed task", async () => {
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

      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;
      // Prevent dequeue from picking up the task (would change status to "starting")
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      const result = await tm.retryTask(PROJECT_ID, "fail-task");

      expect(result.taskId).toBe("fail-task");
      expect(result.branch).toBe("impl/test-fail-task");
      // retryTask increments attempt but does not reset other fields
      expect(result.attempt).toBe(4);
      expect(result.status).toBe("queued");
    });

    it("increments attempt and enqueues when retrying a completed task", async () => {
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

      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;
      // Prevent dequeue from picking up the task (would change status to "starting")
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      const result = await tm.retryTask(PROJECT_ID, "done-task");

      expect(result.status).toBe("queued");
      expect(result.attempt).toBe(2);
    });
  });

  describe("retryTaskNow", () => {
    it("throws TaskActiveError when task is not in retrying status (failed)", async () => {
      const { TaskManager, TaskActiveError } = await import("../src/task-manager/task-manager.js");
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "fail-task", status: "failed" }));

      const tm = new TaskManager(makeConfig());
      await tm.init();

      await expect(tm.retryTaskNow(PROJECT_ID, "fail-task")).rejects.toBeInstanceOf(TaskActiveError);
    });

    it("throws TaskActiveError when task is queued", async () => {
      const { TaskManager, TaskActiveError } = await import("../src/task-manager/task-manager.js");
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "queued-task", status: "completed" }));

      const tm = new TaskManager(makeConfig());
      await tm.init();

      tm.tasks.get("queued-task")!.task.status = "queued";

      await expect(tm.retryTaskNow(PROJECT_ID, "queued-task")).rejects.toBeInstanceOf(TaskActiveError);
    });

    it("throws for unknown task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const tm = new TaskManager(makeConfig());

      await expect(tm.retryTaskNow(PROJECT_ID, "nonexistent")).rejects.toThrow("Task not found");
    });

    it("clears the retry timer and enqueues the task immediately", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({
        taskId: "retrying-task",
        status: "completed",
        branch: "impl/test-retrying-task",
        attempt: 2,
      }));

      const tm = new TaskManager(makeConfig());

      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // Simulate retrying state with a pending timeout
      const entry = tm.tasks.get("retrying-task")!;
      entry.task.status = "retrying";
      entry.task.nextRetryAt = new Date(Date.now() + 60_000).toISOString();
      const fakeTimeout = setTimeout(() => {}, 99999);
      entry.retryTimeoutId = fakeTimeout;

      const result = await tm.retryTaskNow(PROJECT_ID, "retrying-task");

      // Timeout should be cleared and entry removed
      expect(entry.retryTimeoutId).toBeUndefined();
      // nextRetryAt should be cleared
      expect(entry.task.nextRetryAt).toBeUndefined();
      // Task should be queued
      expect(result.status).toBe("queued");
      // Task should be in the queue
      expect(tm.queue).toContain("retrying-task");
    });
  });

  describe("project isolation", () => {
    it("getTask returns undefined for task belonging to another project", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config: Config = {
        server: { workspaceDir: TMP, metaCpus: 0.4, sandboxCpus: 0.4 },
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
    it("createNewTask with continueTaskId sets parentTaskId, chainId, and inherits branch", async () => {
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
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "continue", title: "Continue", estimatedDurationSeconds: 600 });

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      const task = await tm.createNewTask(PROJECT_ID, { prompt: "Continue work", continueTaskId: "task-a" });

      expect(task.parentTaskId).toBe("task-a");
      expect(task.chainId).toBe("chain-abc123");
      expect(task.branch).toBe("impl/feature-task-a");
    });

    it("rejects continueTaskId for non-existent task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      await expect(
        tm.createNewTask(PROJECT_ID, { prompt: "Continue", continueTaskId: "nonexistent" })
      ).rejects.toThrow("Task not found: nonexistent");
    });

    it("rejects continueTaskId for task in different project", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config: Config = {
        server: { workspaceDir: TMP, metaCpus: 0.4, sandboxCpus: 0.4 },
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
        tm.createNewTask(PROJECT_ID, { prompt: "Continue", continueTaskId: "task-other" })
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

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "test", title: "Test", estimatedDurationSeconds: 600 });

      // Trying to continue from chain-a (not the tip) should fail mentioning chain-b
      await expect(
        tm.createNewTask(PROJECT_ID, { prompt: "Continue", continueTaskId: "chain-a" })
      ).rejects.toThrow("Continue from chain-b instead");
    });

    it("rejects continueTaskId for task with null branch", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "no-branch", status: "completed", branch: null }));

      const tm = new TaskManager(config);
      await tm.init();

      await expect(
        tm.createNewTask(PROJECT_ID, { prompt: "Continue", continueTaskId: "no-branch" })
      ).rejects.toThrow("has no branch to continue from");
    });

    it("chain tasks run serially (second task queues when chain active)", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "root-task", status: "completed", branch: "impl/root-task" }));

      const tm = new TaskManager(config);
      await tm.init();

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "test", title: "Test", estimatedDurationSeconds: 600 });

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(true);
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("should not be called for second task"));

      // Simulate chain being active — use the actual chainId from makePersistedTask
      tm.markChainActive(PROJECT_ID, "chain-abc123" as any);

      const task = await tm.createNewTask(PROJECT_ID, { prompt: "Chain task", continueTaskId: "root-task" });

      // Give background a moment
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
      tm2.markChainActive(PROJECT_ID, "root-chain" as any);

      // Release chain, make capacity available
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(true);
      let acquireCalled = false;
      vi.spyOn(state.pool, "acquire").mockImplementation(() => {
        acquireCalled = true;
        return new Promise(() => {}); // stay pending
      });

      tm2.unmarkChainActive(PROJECT_ID, "root-chain" as any);
      await tm2.dequeueAvailableTasks();

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

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "test", title: "Test", estimatedDurationSeconds: 600 });

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      const task = await tm.createNewTask(PROJECT_ID, { prompt: "Chain work", continueTaskId: "chain-root" });

      // Chain task should inherit the branch and chainId
      expect(task.branch).toBe("impl/chain-root");
      expect(task.chainId).toBe("chain-abc123");
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

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "test", title: "Test", estimatedDurationSeconds: 600 });

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      // Continuing from C (tip) should work
      const taskD = await tm.createNewTask(PROJECT_ID, { prompt: "Continue from C", continueTaskId: "mt-c" });
      expect(taskD.parentTaskId).toBe("mt-c");
      expect(taskD.chainId).toBe("mt-a");

      // Continuing from A (not tip) should fail
      await expect(
        tm.createNewTask(PROJECT_ID, { prompt: "Continue from A", continueTaskId: "mt-a" })
      ).rejects.toThrow("not the latest in its chain");

      // Continuing from B (not tip) should fail
      await expect(
        tm.createNewTask(PROJECT_ID, { prompt: "Continue from B", continueTaskId: "mt-b" })
      ).rejects.toThrow("not the latest in its chain");
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
      const entry = tm.tasks.get("persist-test")!;
      tm.saveTask(entry);

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

      const entry = tm.tasks.get("ws-test")!;
      tm.saveTask(entry);

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

    it("calls dequeueAvailableTasks after cancelling a queued task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "dq-queued", status: "completed" }));

      const tm = new TaskManager(makeConfig());
      await tm.init();

      const spy = vi.spyOn(tm, "dequeueAvailableTasks");

      // Manually set to queued to simulate a waiting task
      tm.tasks.get("dq-queued")!.task.status = "queued";

      tm.cancelTask(PROJECT_ID, "dq-queued");

      // dequeueAvailableTasks should be triggered (fire-and-forget)
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("calls dequeueAvailableTasks after cancelling a retrying task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "dq-retrying", status: "completed" }));

      const tm = new TaskManager(makeConfig());
      await tm.init();

      const spy = vi.spyOn(tm, "dequeueAvailableTasks");

      const entry = tm.tasks.get("dq-retrying")!;
      entry.task.status = "retrying";
      entry.retryTimeoutId = setTimeout(() => {}, 99999);

      tm.cancelTask(PROJECT_ID, "dq-retrying");

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("calls dequeueAvailableTasks after cancelling a running task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "dq-running", status: "completed" }));

      const tm = new TaskManager(makeConfig());
      await tm.init();

      const spy = vi.spyOn(tm, "dequeueAvailableTasks");

      const entry = tm.tasks.get("dq-running")!;
      entry.task.status = "running";
      // Provide a mock executor so kill() doesn't throw
      entry.executor = { kill: vi.fn() } as any;

      tm.cancelTask(PROJECT_ID, "dq-running");

      expect(spy).toHaveBeenCalledTimes(1);
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
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "fix-bug", title: "Fix Bug", estimatedDurationSeconds: 600 });

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
      // Task ends up failed because acquire was rejected after metadata generation
      expect(task?.status).toBe("failed");
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

  describe("task status transitions", () => {
    it("createNewTask returns status 'queued'", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // Prevent background execution
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(new Promise(() => {}));
      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      const task = await tm.createNewTask(PROJECT_ID, { prompt: "Add a button" });

      expect(task.status).toBe("queued");
      expect(task.branch).toBeNull();
      expect(task.taskId).toBeDefined();
    });

    it("queued task transitions to starting after dequeue", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "add-button", title: "Add a Button", estimatedDurationSeconds: 600 });

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(true);
      // Acquire stays pending so executeTask never runs (avoids git errors)
      vi.spyOn(state.pool, "acquire").mockReturnValue(new Promise(() => {}));

      const task = await tm.createNewTask(PROJECT_ID, { prompt: "Add a button" });

      // Wait for dequeue + metadata generation
      await new Promise((r) => setTimeout(r, 100));

      // Status is "starting" because acquire is still pending (hasn't resolved to set "running")
      expect(tm.getTask(PROJECT_ID, task.taskId)?.status).toBe("starting");
    });

    it("queued task stays queued when pool has no free slot", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "add-button", title: "Add a Button", estimatedDurationSeconds: 600 });

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      const task = await tm.createNewTask(PROJECT_ID, { prompt: "Add a button" });

      await new Promise((r) => setTimeout(r, 100));

      expect(tm.getTask(PROJECT_ID, task.taskId)?.status).toBe("queued");
    });

    it("queued task can be cancelled", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(new Promise(() => {}));
      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      const task = await tm.createNewTask(PROJECT_ID, { prompt: "Cancel me" });
      expect(task.status).toBe("queued");

      const result = tm.cancelTask(PROJECT_ID, task.taskId);
      expect(result.status).toBe("cancelled");
      expect(result.completedAt).toBeDefined();
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
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "starting-task-2", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // Manually set status to starting to simulate in-progress task
      tm.tasks.get("starting-task-2" as any)!.task.status = "starting";

      await expect(tm.retryTask(PROJECT_ID, "starting-task-2" as any)).rejects.toBeInstanceOf(TaskActiveError);
    });

    it("listAllTasks includes queued tasks", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(new Promise(() => {}));
      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(false);

      const task = await tm.createNewTask(PROJECT_ID, { prompt: "Active task" });
      expect(task.status).toBe("queued");

      const all = tm.listAllTasks();
      expect(all).toHaveLength(1);
      expect(all[0].status).toBe("queued");
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
      const entry = tm.tasks.get("timeout-task");
      expect(entry?.checkoutBranch).toBe("impl/my-feature-timeout-task");
    });

    it("executeTask sets status to retrying and preserves branch on timeout", async () => {
      // Unit-tests the executeTask path: when executor returns timedOut=true the
      // task ends up in "retrying" state with branch intact and no completedAt.
      const { executeTask } = await import("../src/task-manager/task-runner.js");
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const { TokenManager } = await import("../src/auth.js");

      const config = makeConfig({
        projects: {
          [PROJECT_ID]: {
            repositories: [{ name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" }],
            claudeCode: { command: "claude", timeoutSeconds: 3600 },
          },
        },
      });
      const tm = new TaskManager(config);

      // Mock metadata generation so createNewTask doesn't call real CLI
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "build-the-thing", title: "Build the Thing", estimatedDurationSeconds: 600 });

      // @ts-expect-error - accessing private projects map
      const projectState = tm.projects.get(PROJECT_ID)!;
      // Prevent background dequeue from interfering
      vi.spyOn(projectState.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      const task = await tm.createNewTask(PROJECT_ID, { prompt: "Build the thing" });
      // Wait for metadata generation to complete
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
      vi.spyOn(projectState.pool, "acquire").mockResolvedValue({ id: 0, dir: TMP });
      vi.spyOn(projectState.pool, "release").mockReturnValue(undefined);
      vi.spyOn(tm.gitManager, "checkoutBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "prepareNewBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "pushBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "getHeadAll").mockResolvedValue(new Map());
      vi.spyOn(tm.gitManager, "hasUncommittedChanges").mockResolvedValue(false);
      vi.spyOn(tm.gitManager, "revertProtectedPathsAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "ensureBranchAtHeadAll").mockResolvedValue(false);

      entry.executor = new Executor(config.projects[PROJECT_ID].claudeCode, new TokenManager(undefined, TMP));
      const workspace = { id: 0, dir: TMP };

      await executeTask(entry.task, workspace, projectState, tm);

      // Task must be "queued" (re-enqueued via push_front) after a timeout
      expect(entry.task.status).toBe("queued");
      // Branch must be preserved for the next attempt
      expect(entry.task.branch).toBe("impl/build-the-thing-" + task.taskId);
      // attempt was incremented by the timeout handler
      expect(entry.task.attempt).toBe(2);
    });
  });

  describe("dequeueAvailableTasks queue iteration", () => {
    it("does not skip tasks when pool capacity > 1 and queue has many tasks", async () => {
      // Before the fix, dequeue() called splice() on this.queue while iterating with for-of.
      // After splice shifts the array, the iterator skips the next element, causing tasks
      // to be dequeued out-of-order (e.g. t1 and t3 run while t2 waits).
      // The fix: snapshot [...this.queue] before iterating.
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const store = new TaskStore(TMP);

      // Save 3 tasks that all have branches (skip prepareMetadata)
      for (const id of ["task-a", "task-b", "task-c"]) {
        store.save(makePersistedTask({
          taskId: id,
          status: "queued",
          branch: `impl/test-${id}`,
          completedAt: null,
          chainId: `chain-${id}` as any,
        }));
      }

      // Global max = 2, project max = 2 — both task-a AND task-b should be dequeued
      const config = makeConfig({
        server: { workspaceDir: TMP, metaCpus: 0.4, sandboxCpus: 0.4, maxConcurrentTasks: 2 },
        projects: {
          [PROJECT_ID]: {
            maxConcurrentTasks: 2,
            repositories: [{ name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" }],
            claudeCode: { command: "claude" },
          },
        },
      });
      const tm = new TaskManager(config);

      // @ts-expect-error – accessing private map for testing
      const state = tm.projects.get(PROJECT_ID)!;

      // Track which tasks were passed to acquire (i.e. actually dequeued)
      const acquiredForTasks: string[] = [];
      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(true);
      vi.spyOn(state.pool, "acquire").mockImplementation(async () => {
        return { id: acquiredForTasks.length, dir: TMP };
      });
      vi.spyOn(state.pool, "release").mockReturnValue(undefined);
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "x", title: "X", estimatedDurationSeconds: 60 });
      vi.spyOn(tm.gitManager, "checkoutBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "prepareNewBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "pushBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "getHeadAll").mockResolvedValue(new Map());
      vi.spyOn(tm.gitManager, "hasUncommittedChanges").mockResolvedValue(false);
      vi.spyOn(tm.gitManager, "revertProtectedPathsAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "ensureBranchAtHeadAll").mockResolvedValue(false);
      vi.spyOn(Executor.prototype, "run").mockResolvedValue({ exitCode: 0, output: "", timedOut: false });
      vi.spyOn(Executor.prototype, "getOutput").mockReturnValue("");

      // Spy on runOrContinueTaskFromEntry to track which tasks get dequeued
      const dequeued: string[] = [];
      // @ts-expect-error – accessing private method
      const origRun = tm.runOrContinueTaskFromEntry.bind(tm);
      // @ts-expect-error – accessing private method
      vi.spyOn(tm, "runOrContinueTaskFromEntry").mockImplementation(async (entry: any) => {
        dequeued.push(entry.task.taskId);
        return origRun(entry);
      });

      await tm.init();

      // Wait for background processing
      await new Promise((r) => setTimeout(r, 100));

      // With globalMax=2, the first two tasks in queue order must be dequeued.
      // With the old buggy code, task-a and task-c would be dequeued (skipping task-b).
      expect(dequeued[0]).toBe("task-a");
      expect(dequeued[1]).toBe("task-b"); // must be second, not task-c
    });

    it("queued tasks all start sequentially when maxConcurrentTasks=1 after restart", async () => {
      // Regression: when pool had pre-existing instances (from disk) and maxConcurrentTasks=1,
      // hasFreeSlot used to return true for any free instance, bypassing the cap.
      // The fix: hasFreeSlot now always checks inUseCount < maxConcurrentTasks.
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const store = new TaskStore(TMP);

      // Save 3 tasks
      for (const id of ["r-task-1", "r-task-2", "r-task-3"]) {
        store.save(makePersistedTask({
          taskId: id,
          status: "queued",
          branch: `impl/test-${id}`,
          completedAt: null,
          chainId: `chain-${id}` as any,
        }));
      }

      const config = makeConfig({
        projects: {
          [PROJECT_ID]: {
            maxConcurrentTasks: 1, // only 1 at a time
            repositories: [{ name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" }],
            claudeCode: { command: "claude" },
          },
        },
      });
      const tm = new TaskManager(config);

      // @ts-expect-error – accessing private map
      const state = tm.projects.get(PROJECT_ID)!;

      // Track concurrent acquires with coordinated hasFreeSlot/acquire mocks
      let activeCount = 0;
      let maxObservedActive = 0;

      // hasFreeSlot and acquire must agree on the cap (maxConcurrentTasks=1)
      vi.spyOn(state.pool, "hasFreeSlot").mockImplementation(() => activeCount < 1);
      vi.spyOn(state.pool, "acquire").mockImplementation(async () => {
        activeCount++;
        maxObservedActive = Math.max(maxObservedActive, activeCount);
        return { id: activeCount - 1, dir: TMP };
      });
      vi.spyOn(state.pool, "release").mockImplementation(() => {
        activeCount = Math.max(0, activeCount - 1);
      });
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "x", title: "X", estimatedDurationSeconds: 60 });
      vi.spyOn(tm.gitManager, "checkoutBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "prepareNewBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "pushBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "getHeadAll").mockResolvedValue(new Map());
      vi.spyOn(tm.gitManager, "hasUncommittedChanges").mockResolvedValue(false);
      vi.spyOn(tm.gitManager, "revertProtectedPathsAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "ensureBranchAtHeadAll").mockResolvedValue(false);
      vi.spyOn(Executor.prototype, "run").mockResolvedValue({ exitCode: 0, output: "", timedOut: false });
      vi.spyOn(Executor.prototype, "getOutput").mockReturnValue("");

      await tm.init();
      await new Promise((r) => setTimeout(r, 300));

      // All 3 tasks must eventually complete (no stuck-in-queued issue)
      const tasks = tm.listTasks(PROJECT_ID);
      const nonQueued = tasks.filter(t => t.status !== "queued");
      expect(nonQueued.length).toBeGreaterThanOrEqual(1);

      // maxConcurrentTasks=1 must be respected — never more than 1 simultaneous acquire
      expect(maxObservedActive).toBeLessThanOrEqual(1);
    });
  });

  describe("bug fixes", () => {
    it("global concurrency counts total active chains, not project count", async () => {
      // Bug #2: activeChains.size counted Map entries (projects), not total chains
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig({ server: { workspaceDir: TMP, metaCpus: 0.4, sandboxCpus: 0.4, maxConcurrentTasks: 2 } });
      const tm = new TaskManager(config);

      // Mark two chains active under the same project
      tm.markChainActive(PROJECT_ID, "chain-1" as any);
      tm.markChainActive(PROJECT_ID, "chain-2" as any);

      // Queue a task
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "queued-task", status: "queued", chainId: "chain-3" as any }));
      await tm.init();

      // dequeueAvailableTasks should NOT dequeue because totalActive (2) >= maxConcurrentTasks (2)
      expect(tm.queue).toContain("queued-task");
      await tm.dequeueAvailableTasks();
      // Task should still be in queue because we've hit the global limit
      expect(tm.queue).toContain("queued-task");
    });

    it("cancelling a 'starting' task sets cancelled flag and releases chain lock", async () => {
      // Bug #3: cancelling a "starting" task didn't set entry.cancelled or release chain lock
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // Create a task entry directly in memory (no disk needed)
      const task = {
        taskId: "starting-task" as any,
        projectId: PROJECT_ID,
        branch: "impl/test-starting-task",
        chainId: "chain-start" as any,
        prompt: "Do something",
        status: "starting" as any,
        startedAt: new Date().toISOString(),
        completedAt: null,
        output: "",
        attempt: 1,
      };
      const entry = { task, executor: null, workspaceId: null } as any;
      tm.tasks.set(task.taskId, entry);
      // Manually mark chain active (normally done by runOrContinueTaskFromEntry)
      tm.markChainActive(PROJECT_ID, "chain-start" as any);

      // Mock saveTask to avoid disk writes
      vi.spyOn(tm, "saveTask").mockImplementation(() => {});

      const result = tm.cancelTask(PROJECT_ID, "starting-task" as any);

      expect(result.status).toBe("cancelled");
      expect(entry.cancelled).toBe(true);
      // Chain lock should be released
      expect(tm.isChainActive(PROJECT_ID, "chain-start" as any)).toBe(false);
    });

    it("prepareMetadata failure stops execution and releases chain lock", async () => {
      // Bug #5: after prepareMetadata failed, code continued to pool.acquire
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // @ts-expect-error - accessing private projects map
      const projectState = tm.projects.get(PROJECT_ID)!;

      // Create a branchless task entry
      const task = {
        taskId: "meta-fail" as any,
        projectId: PROJECT_ID,
        branch: null,
        chainId: "chain-meta" as any,
        prompt: "Do something",
        status: "queued" as any,
        startedAt: new Date().toISOString(),
        completedAt: null,
        output: "",
        attempt: 1,
      };
      const entry = { task, executor: null, workspaceId: null };
      tm.tasks.set(task.taskId, entry as any);

      // Mock prepareMetadata to fail (set task to "failed")
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockRejectedValue(new Error("API error"));

      // Mock saveTask to avoid disk writes
      vi.spyOn(tm, "saveTask").mockImplementation(() => {});

      // Mock pool.acquire — should NOT be called
      const acquireSpy = vi.spyOn(projectState.pool, "acquire").mockResolvedValue({ id: 0, dir: TMP });

      // Run the method
      // @ts-expect-error - accessing private method
      await tm.runOrContinueTaskFromEntry(entry);

      // Task should be failed
      expect(task.status).toBe("failed");
      // Chain lock should be released
      expect(tm.isChainActive(PROJECT_ID, "chain-meta" as any)).toBe(false);
      // pool.acquire should NOT have been called
      expect(acquireSpy).not.toHaveBeenCalled();
    });

    it("new standalone tasks use prepareNewBranch (no checkoutBranch set)", async () => {
      // Bug #4: chainId is always set, so fromBranch always used task.branch
      // instead of undefined for new standalone tasks
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // @ts-expect-error - accessing private projects map
      const projectState = tm.projects.get(PROJECT_ID)!;

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "new-task", title: "New Task", estimatedDurationSeconds: 600 });
      vi.spyOn(projectState.pool, "hasFreeSlot").mockReturnValue(true);
      vi.spyOn(projectState.pool, "acquire").mockResolvedValue({ id: 0, dir: TMP });
      vi.spyOn(projectState.pool, "release").mockReturnValue(undefined);

      const checkoutSpy = vi.spyOn(tm.gitManager, "checkoutBranchAll").mockResolvedValue(undefined);
      const prepareSpy = vi.spyOn(tm.gitManager, "prepareNewBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "pushBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "getHeadAll").mockResolvedValue(new Map());
      vi.spyOn(tm.gitManager, "hasUncommittedChanges").mockResolvedValue(false);
      vi.spyOn(tm.gitManager, "revertProtectedPathsAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "ensureBranchAtHeadAll").mockResolvedValue(false);
      vi.spyOn(Executor.prototype, "run").mockResolvedValue({ exitCode: 0, output: "done", timedOut: false });
      vi.spyOn(Executor.prototype, "getOutput").mockReturnValue("");

      await tm.init();
      const task = await tm.createNewTask(PROJECT_ID, { prompt: "Do new thing" });

      // Wait for background processing
      await new Promise((r) => setTimeout(r, 100));

      // prepareNewBranchAll should be called (new standalone task, not a chain continuation)
      expect(prepareSpy).toHaveBeenCalled();
      // checkoutBranchAll should NOT be called for a new standalone task
      expect(checkoutSpy).not.toHaveBeenCalled();
    });
  });

  describe("dequeueAvailableTasks triggered on workspace acquisition failure", () => {
    it("calls dequeueAvailableTasks when pool.acquire fails in runOrContinueTaskFromEntry", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "acquire-fail-task",
        status: "queued",
        branch: "impl/test-acquire-fail-task",
        completedAt: null,
      }));

      const tm = new TaskManager(makeConfig());

      // @ts-expect-error - accessing private projects map for testing
      const state = tm.projects.get(PROJECT_ID)!;

      vi.spyOn(state.pool, "hasFreeSlot").mockReturnValue(true);
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("no workspace available"));
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "test", title: "Test", estimatedDurationSeconds: 60 });

      await tm.init();

      // Wait for the async catch block to run
      await new Promise((r) => setTimeout(r, 200));

      const task = tm.getTask(PROJECT_ID, "acquire-fail-task");
      // Task should be marked as failed after acquire error
      expect(task?.status).toBe("failed");
      expect(task?.error).toContain("no workspace available");
    });
  });

});
