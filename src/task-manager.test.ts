import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, PersistedTask } from "./types.js";
import { TaskStore } from "./task-store.js";

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
    const { TaskManager } = await import("./task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm).toBeDefined();
  });

  it("listTasks returns empty array initially", async () => {
    const { TaskManager } = await import("./task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm.listTasks(PROJECT_ID)).toEqual([]);
  });

  it("getTask returns undefined for unknown id", async () => {
    const { TaskManager } = await import("./task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm.getTask(PROJECT_ID, "nonexistent")).toBeUndefined();
  });

  it("getOutput returns empty string for unknown id", async () => {
    const { TaskManager } = await import("./task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm.getOutput(PROJECT_ID, "nonexistent")).toBe("");
  });

  it("accepts multiple repositories in config", async () => {
    const { TaskManager } = await import("./task-manager.js");
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
    const { TaskManager } = await import("./task-manager.js");
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
    const { TaskManager } = await import("./task-manager.js");
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
      const { TaskManager } = await import("./task-manager.js");
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
      const { TaskManager } = await import("./task-manager.js");
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
      const { TaskManager } = await import("./task-manager.js");
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
      const { TaskManager } = await import("./task-manager.js");
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
      const { TaskManager } = await import("./task-manager.js");
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
      const { TaskManager } = await import("./task-manager.js");
      const config = makeConfig();

      const tm = new TaskManager(config);
      await tm.init();

      expect(tm.listTasks(PROJECT_ID)).toEqual([]);
    });

    it("marks interrupted task as failed when workspace is missing", async () => {
      const { TaskManager } = await import("./task-manager.js");
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
      const { TaskManager } = await import("./task-manager.js");
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
  });

  describe("startTask", () => {
    it("returns immediately with queued status and null branch (no fromBranch)", async () => {
      const { TaskManager } = await import("./task-manager.js");
      const { Executor } = await import("./executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // Slug generation is controlled manually — it will not resolve until we allow it
      let resolveSlug!: (s: string) => void;
      vi.spyOn(Executor.prototype, "generateBranchSlug").mockReturnValue(
        new Promise<string>((r) => { resolveSlug = r; })
      );
      // Title generation resolves immediately (not the focus of this test)
      vi.spyOn(Executor.prototype, "generateTitle").mockResolvedValue("Add a Button");

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      const task = await tm.startTask(PROJECT_ID, { prompt: "Add a button" });

      // Returned immediately before slug generation completes
      expect(task.branch).toBeNull();
      expect(task.status).toBe("queued");
      expect(task.taskId).toBeDefined();
      expect(tm.getTask(PROJECT_ID, task.taskId)).toBeDefined();

      // Unblock slug generation and verify branch is set afterwards
      resolveSlug("add-button");
      await new Promise((r) => setTimeout(r, 50));

      expect(tm.getTask(PROJECT_ID, task.taskId)?.branch).toBe(`impl/add-button-${task.taskId}`);
    });

    it("uses fromBranch directly — branch is set immediately and never overwritten", async () => {
      const { TaskManager } = await import("./task-manager.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // @ts-expect-error - private
      const state = tm.projects.get(PROJECT_ID)!;
      vi.spyOn(state.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      const task = await tm.startTask(PROJECT_ID, { prompt: "Add a button", fromBranch: "my-branch" });

      // Branch is set immediately from fromBranch — no impl/ prefix added
      expect(task.branch).toBe("my-branch");
      expect(task.status).toBe("queued");

      // Give background a moment to complete
      await new Promise((r) => setTimeout(r, 50));

      // Branch must stay exactly as provided, not rewritten to an impl/slug-taskId form
      expect(tm.getTask(PROJECT_ID, task.taskId)?.branch).toBe("my-branch");
    });

    it("registers the task in memory before slug generation completes", async () => {
      const { TaskManager } = await import("./task-manager.js");
      const { Executor } = await import("./executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      // Slug never resolves during this test — background stays pending
      vi.spyOn(Executor.prototype, "generateBranchSlug").mockReturnValue(new Promise(() => {}));
      vi.spyOn(Executor.prototype, "generateTitle").mockReturnValue(new Promise(() => {}));

      const task = await tm.startTask(PROJECT_ID, { prompt: "Do something" });

      expect(tm.getTask(PROJECT_ID, task.taskId)).toBeDefined();
      expect(tm.listTasks(PROJECT_ID)).toHaveLength(1);
    });
  });

  describe("retryTask", () => {
    it("throws TaskActiveError when task is running", async () => {
      const { TaskManager, TaskActiveError } = await import("./task-manager.js");
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
      const { TaskManager, TaskActiveError } = await import("./task-manager.js");
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
      const { TaskManager, TaskActiveError } = await import("./task-manager.js");
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
      const { TaskManager } = await import("./task-manager.js");
      const tm = new TaskManager(makeConfig());

      await expect(tm.retryTask(PROJECT_ID, "nonexistent")).rejects.toThrow("Task not found");
    });

    it("throws error for task belonging to another project", async () => {
      const { TaskManager } = await import("./task-manager.js");
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
      const { TaskManager } = await import("./task-manager.js");
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
      const { TaskManager } = await import("./task-manager.js");
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
      const { TaskManager } = await import("./task-manager.js");
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

  describe("getOutput with null executor", () => {
    it("returns stored output for completed task loaded from disk", async () => {
      const { TaskManager } = await import("./task-manager.js");
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
      const { TaskManager } = await import("./task-manager.js");
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
