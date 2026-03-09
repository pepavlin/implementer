import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedTask, Branch } from "../src/types.js";
import type { Config } from "../src/config/config.js";
import { Project } from "../src/config/project.js";
import type { ProjectConfig } from "../src/config/config-types.js";
import { TaskStore } from "../src/task-store.js";

const TMP = join(import.meta.dirname, "..", "tmp", "task-manager-test");
const PROJECT_ID = "test-project";

function makeConfig(overrides: Partial<any> = {}): Config {
  const serverConfig = {
    workspaceDir: TMP,
    maxConcurrentTasks: 3,
    metaCpus: 0.4,
    sandboxCpus: 0.4,
    ...(overrides.server ?? {}),
  };

  const projectConfigs: Record<string, any> = overrides.projects ?? {
    [PROJECT_ID]: {
      maxConcurrentTasks: 4,
      repositories: [
        { name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" },
      ],
      claudeCode: {
        command: "claude",
      },
    },
  };

  const config = {
    server: serverConfig,
    projects: {} as Record<string, Project>,
    configPath: join(TMP, "config.yaml"),
  } as Config;

  for (const [key, value] of Object.entries(projectConfigs)) {
    config.projects[key as any] = new Project(value as ProjectConfig, key as any, config);
  }

  return config;
}

function makeBranch(name: string): Branch {
  return { name, createdAt: "2025-01-01T00:00:00.000Z" };
}

function makePersistedTask(overrides: Partial<any> = {}): PersistedTask {
  const branch = overrides.branch === null || overrides.branch === undefined
    ? undefined
    : (typeof overrides.branch === "string" ? makeBranch(overrides.branch) : overrides.branch);

  return {
    taskId: "abc123",
    projectId: PROJECT_ID,
    branch,
    prompt: "Add a button",
    status: "completed",
    startedAt: "2025-01-01T00:00:00.000Z",
    completedAt: "2025-01-01T01:00:00.000Z",
    output: "Done",
    workspaceId: 0,
    attempt: 1,
    chainId: "chain-abc123",
    ...overrides,
    // Override branch after spread so our conversion takes precedence
    ...(overrides.branch !== undefined ? { branch } : {}),
  } as any;
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
    expect(tm.listTasks(PROJECT_ID as any)).toEqual([]);
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
    expect(tm.getTask("nonexistent" as any)).toBeUndefined();
  });

  it("getOutput returns empty string for unknown id", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config);
    expect(tm.getOutput("nonexistent" as any)).toBe("");
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
    const config = makeConfig({
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
    });
    const tm = new TaskManager(config);
    expect(tm).toBeDefined();
    expect(tm.listTasks("project-a" as any)).toEqual([]);
    expect(tm.listTasks("project-b" as any)).toEqual([]);
  });

  describe("init", () => {
    it("loads completed tasks from disk into memory", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "task-1", status: "completed" }));
      store.save(makePersistedTask({ taskId: "task-2", status: "failed", error: "boom" }));

      const tm = new TaskManager(config);
      await tm.init();

      expect(tm.listTasks(PROJECT_ID as any)).toHaveLength(2);
      const t1 = tm.getTask("task-1" as any);
      expect(t1?.data.status).toBe("completed");
      const t2 = tm.getTask("task-2" as any);
      expect(t2?.data.status).toBe("failed");
      expect(t2?.data.error).toBe("boom");
    });

    it("marks running tasks as interrupted and enqueues them", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "running-task",
        status: "running",
        completedAt: null,
        workspaceId: 0,
      }));

      mkdirSync(join(TMP, "projects", PROJECT_ID, "instances", "0"), { recursive: true });

      const tm = new TaskManager(config);

      // Prevent dequeue from picking up the task during init
      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // After init, interrupted tasks are pushed to front of queue and become queued
      const onDisk = JSON.parse(
        readFileSync(join(TMP, "tasks", "running-task.json"), "utf-8"),
      );
      expect(onDisk.status).toBe("queued");
    });

    it("leaves retrying tasks as-is for dequeueAvailableTasks to handle", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      // Task was in "retrying" state when server died
      store.save(makePersistedTask({
        taskId: "retrying-task",
        status: "retrying" as any,
        completedAt: null,
        workspaceId: null,
        attempt: 2,
        branch: "impl/test-retrying-task",
        nextRetryAt: new Date(Date.now() - 10_000).toISOString(), // past due
      }));

      const tm = new TaskManager(config);
      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // After init, task stays "retrying" — dequeueAvailableTasks will promote it
      // when nextRetryAt has passed (which it has, since it's in the past)
      const task = tm.getTask("retrying-task" as any);
      // dequeueAvailableTasks is called during init, so the task should now be "queued"
      expect(task?.data.status).toBe("queued");
      expect(task?.data.attempt).toBe(3); // incremented by dequeueAvailableTasks
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

      const task = tm.getTask("done-task" as any);
      expect(task?.data.status).toBe("completed");
      expect(task?.data.output).toBe("All done");
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

      const task = tm.getTask("fail-task" as any);
      expect(task?.data.status).toBe("failed");
      expect(task?.data.error).toBe("Something went wrong");
    });

    it("works with empty task store", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();

      const tm = new TaskManager(config);
      await tm.init();

      expect(tm.listTasks(PROJECT_ID as any)).toEqual([]);
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

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "test", title: "Test", estimatedDurationSeconds: 600 });

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "acquire").mockRejectedValue(new Error("Workspace not available"));

      await tm.init();

      // Wait for the async dequeue/acquire to fail
      await new Promise((r) => setTimeout(r, 50));

      const task = tm.getTask("orphan-task" as any);
      expect(task?.data.status).toBe("failed");
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

    it("interrupted tasks are recovered and re-enqueued", async () => {
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

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // After recovery, interrupted tasks should be re-enqueued with their branch preserved
      const task = tm.tasks.get("resumed-flag-task" as any);
      expect(task?.branch?.name).toBe("impl/test-resumed-flag-task");
      expect(task?.data.status).toBe("queued");
    });

    it("preserves title on disk when task is re-enqueued after restart", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "titled-task",
        status: "running",
        completedAt: null,
        workspaceId: 0,
        branch: "impl/test-titled-task",
        title: "Add dark mode toggle",
      }));

      mkdirSync(join(TMP, "projects", PROJECT_ID, "instances", "0"), { recursive: true });

      const tm = new TaskManager(config);

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // Title should survive the re-enqueue tickUpdate call
      const task = tm.tasks.get("titled-task" as any);
      expect(task?.title).toBe("Add dark mode toggle");

      const onDisk = JSON.parse(
        readFileSync(join(TMP, "tasks", "titled-task.json"), "utf-8"),
      );
      expect(onDisk.title).toBe("Add dark mode toggle");
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

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // After recovery, interrupted tasks should be queued
      const task = tm.getTask("restart-retry-task" as any);
      expect(task?.data.status).toBe("queued");
      expect(task?.data.attempt).toBe(1); // attempt not changed by recovery itself

      // Branch should be preserved for the next run
      const entry = tm.tasks.get("restart-retry-task" as any);
      expect(entry?.branch?.name).toBe("impl/test-restart-retry-task");
    });

    it("retrying tasks with past nextRetryAt are re-queued on restart", async () => {
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
        nextRetryAt: new Date(Date.now() - 10_000).toISOString(), // past due
      }));

      const tm = new TaskManager(config);

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      const task = tm.getTask("multi-retry-task" as any);
      // dequeueAvailableTasks promotes retrying with past nextRetryAt → queued
      expect(task?.data.status).toBe("queued");
      expect(task?.data.attempt).toBe(3); // incremented by promotion
    });
  });

  describe("createNewTask", () => {
    it("returns immediately with queued status and no branch", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "add-button", title: "Add a Button", estimatedDurationSeconds: 600 });

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask(PROJECT_ID as any, { prompt: "Add a button" });

      // Returned immediately — task is queued, branch not yet generated
      expect(task.branch).toBeUndefined();
      expect(task.data.status).toBe("queued");
      expect(task.id).toBeDefined();
      expect(tm.getTask(task.id)).toBeDefined();
    });

    it("registers the task in memory before slug generation completes", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(new Promise(() => {}));

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask(PROJECT_ID as any, { prompt: "Do something" });

      expect(tm.getTask(task.id)).toBeDefined();
      expect(tm.listTasks(PROJECT_ID as any)).toHaveLength(1);
    });
  });

  describe("retryTask", () => {
    it("throws TaskActiveError when task is running", async () => {
      const { TaskManager, TaskActiveError } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "run-task", status: "running", completedAt: null }));

      const tm = new TaskManager(config);

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // Manually set status to running in memory (init changed it to queued via interrupted)
      tm.tasks.get("run-task" as any)!.data.status = "running";

      expect(() => tm.retryTask(PROJECT_ID as any, "run-task" as any)).toThrow(TaskActiveError);
    });

    it("throws TaskActiveError when task is queued", async () => {
      const { TaskManager, TaskActiveError } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "queued-task", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      tm.tasks.get("queued-task" as any)!.data.status = "queued";

      expect(() => tm.retryTask(PROJECT_ID as any, "queued-task" as any)).toThrow(TaskActiveError);
    });

    it("allows manual retry of retrying task (skips delay)", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "retry-task", status: "completed", branch: "impl/test-retry-task" }));

      const tm = new TaskManager(config);

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // Manually flip status to "retrying" to simulate an active auto-retry
      const task = tm.tasks.get("retry-task" as any)!;
      task.data.status = "retrying";
      task.data.nextRetryAt = new Date(Date.now() + 60_000).toISOString();

      // In the new API, retryTask allows retrying tasks (skips the delay)
      const result = tm.retryTask(PROJECT_ID as any, "retry-task" as any);
      expect(result.data.status).toBe("queued");
      expect(result.data.nextRetryAt).toBeUndefined();
    });

    it("throws error for unknown task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const tm = new TaskManager(makeConfig());

      expect(() => tm.retryTask(PROJECT_ID as any, "nonexistent" as any)).toThrow("Task not found");
    });

    it("throws error for task belonging to another project", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig({
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
      });
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "other-task", projectId: PROJECT_ID, status: "failed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // "other-task" belongs to PROJECT_ID, so "other-project" cannot access it
      expect(() => tm.retryTask("other-project" as any, "other-task" as any)).toThrow("Task not found");
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

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      const result = tm.retryTask(PROJECT_ID as any, "fail-task" as any);

      expect(result.id).toBe("fail-task");
      expect(result.branch?.name).toBe("impl/test-fail-task");
      expect(result.data.attempt).toBe(4);
      expect(result.data.status).toBe("queued");
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

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      const result = tm.retryTask(PROJECT_ID as any, "done-task" as any);

      expect(result.data.status).toBe("queued");
      expect(result.data.attempt).toBe(2);
    });
  });

  describe("project isolation", () => {
    it("getTask returns undefined for task belonging to another project", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig({
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
      });
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "task-a", projectId: "project-a", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // getTask returns by taskId (no project scoping)
      expect(tm.getTask("task-a" as any)).toBeDefined();
      // listTasks is scoped
      expect(tm.listTasks("project-a" as any)).toHaveLength(1);
      expect(tm.listTasks("project-b" as any)).toHaveLength(0);
    });
  });

  describe("task chains", () => {
    it("createNewTask with continueTaskId sets parentTaskId, chainId, and inherits branch", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "task-a",
        status: "completed",
        branch: "impl/feature-task-a",
        output: "Done",
      }));

      const tm = new TaskManager(config);
      await tm.init();

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "continue", title: "Continue", estimatedDurationSeconds: 600 });

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      const task = tm.createNewTask(PROJECT_ID as any, { prompt: "Continue work", continueTaskId: "task-a" as any });

      expect(task.data.parentTaskId).toBe("task-a");
      expect(task.data.chainId).toBe("chain-abc123");
      expect(task.branch?.name).toBe("impl/feature-task-a");
    });

    it("rejects continueTaskId for non-existent task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      expect(() =>
        tm.createNewTask(PROJECT_ID as any, { prompt: "Continue", continueTaskId: "nonexistent" as any })
      ).toThrow("Task not found: nonexistent");
    });

    it("rejects continueTaskId for task in different project", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig({
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
      });
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "task-other", projectId: "other-project", status: "completed", branch: "impl/other" }));

      const tm = new TaskManager(config);
      await tm.init();

      expect(() =>
        tm.createNewTask(PROJECT_ID as any, { prompt: "Continue", continueTaskId: "task-other" as any })
      ).toThrow("Task not found: task-other");
    });

    it("rejects continueTaskId that is not the chain tip (error mentions the actual tip)", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "chain-a", status: "completed", branch: "impl/chain-a" }));
      store.save(makePersistedTask({ taskId: "chain-b", status: "completed", branch: "impl/chain-a", parentTaskId: "chain-a", chainId: "chain-a" }));

      const tm = new TaskManager(config);
      await tm.init();

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "test", title: "Test", estimatedDurationSeconds: 600 });

      expect(() =>
        tm.createNewTask(PROJECT_ID as any, { prompt: "Continue", continueTaskId: "chain-a" as any })
      ).toThrow("Continue from chain-b instead");
    });

    it("rejects continueTaskId for task with no branch", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "no-branch", status: "completed", branch: null }));

      const tm = new TaskManager(config);
      await tm.init();

      expect(() =>
        tm.createNewTask(PROJECT_ID as any, { prompt: "Continue", continueTaskId: "no-branch" as any })
      ).toThrow("has no branch to continue from");
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

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(true);
      vi.spyOn(project.pool, "acquire").mockReturnValue(new Promise(() => {}));

      // Put a fake task in the chain as "running" to make the chain active
      const fakeRunning = makePersistedTask({
        taskId: "fake-running",
        status: "running",
        chainId: "chain-abc123",
        completedAt: null,
      });
      const { Task } = await import("../src/task-manager/task.js");
      const fakeTask = new Task(fakeRunning as any, tm);
      fakeTask.data.status = "running";
      tm.tasks.set("fake-running" as any, fakeTask);

      const task = tm.createNewTask(PROJECT_ID as any, { prompt: "Chain task", continueTaskId: "root-task" as any });

      await new Promise((r) => setTimeout(r, 80));

      // Despite free capacity, task should be queued because chain is active
      expect(tm.getTask(task.id)?.data.status).toBe("queued");
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

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      const task = tm.createNewTask(PROJECT_ID as any, { prompt: "Chain work", continueTaskId: "chain-root" as any });

      // Chain task should inherit the branch and chainId
      expect(task.branch?.name).toBe("impl/chain-root");
      expect(task.data.chainId).toBe("chain-abc123");
    });

    it("multi-task chain: A->B->C, continuing from C works, from A/B rejected", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "mt-a", status: "completed", branch: "impl/mt-a" }));
      store.save(makePersistedTask({ taskId: "mt-b", status: "completed", branch: "impl/mt-a", parentTaskId: "mt-a", chainId: "mt-a" }));
      store.save(makePersistedTask({ taskId: "mt-c", status: "completed", branch: "impl/mt-a", parentTaskId: "mt-b", chainId: "mt-a" }));

      const tm = new TaskManager(config);
      await tm.init();

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "test", title: "Test", estimatedDurationSeconds: 600 });

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      // Continuing from C (tip) should work
      const taskD = tm.createNewTask(PROJECT_ID as any, { prompt: "Continue from C", continueTaskId: "mt-c" as any });
      expect(taskD.data.parentTaskId).toBe("mt-c");
      expect(taskD.data.chainId).toBe("mt-a");

      // Continuing from A (not tip) should fail
      expect(() =>
        tm.createNewTask(PROJECT_ID as any, { prompt: "Continue from A", continueTaskId: "mt-a" as any })
      ).toThrow("not the latest in its chain");

      // Continuing from B (not tip) should fail
      expect(() =>
        tm.createNewTask(PROJECT_ID as any, { prompt: "Continue from B", continueTaskId: "mt-b" as any })
      ).toThrow("not the latest in its chain");
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

      expect(tm.getOutput("stored-task" as any)).toBe("The final output");
    });

    it("returns stored output for task with no executor", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "no-exec-task",
        status: "interrupted",
        output: "",
      }));

      const tm = new TaskManager(config);

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      expect(tm.getOutput("no-exec-task" as any)).toBe("");
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
      tm.tasks.get("cancel-queued" as any)!.data.status = "queued";

      const result = await tm.cancelTask(PROJECT_ID as any, "cancel-queued" as any);
      expect(result.data.status).toBe("cancelled");
      expect(result.data.completedAt).toBeDefined();

      const onDisk = JSON.parse(
        readFileSync(join(TMP, "tasks", "cancel-queued.json"), "utf-8"),
      );
      expect(onDisk.status).toBe("cancelled");
    });

    it("cancels a retrying task and clears nextRetryAt", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "cancel-retrying", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // Set task to retrying
      const task = tm.tasks.get("cancel-retrying" as any)!;
      task.data.status = "retrying";
      task.data.nextRetryAt = new Date(Date.now() + 60_000).toISOString();

      const result = await tm.cancelTask(PROJECT_ID as any, "cancel-retrying" as any);
      expect(result.data.status).toBe("cancelled");
      expect(result.data.nextRetryAt).toBeUndefined();
    });

    it("cancels a completed task (now allowed)", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({ taskId: "cancel-done", status: "completed" }));

      const tm = new TaskManager(config);
      await tm.init();

      // cancel() now works on any task — no TaskCancelError
      const result = await tm.cancelTask(PROJECT_ID as any, "cancel-done" as any);
      expect(result.data.status).toBe("cancelled");
    });

    it("throws for unknown task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const tm = new TaskManager(makeConfig());

      await expect(tm.cancelTask(PROJECT_ID as any, "nonexistent" as any)).rejects.toThrow("Task not found");
    });

    it("calls dequeueAvailableTasks after cancelling a queued task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "dq-queued", status: "completed" }));

      const tm = new TaskManager(makeConfig());
      await tm.init();

      const spy = vi.spyOn(tm, "dequeueAvailableTasks");

      tm.tasks.get("dq-queued" as any)!.data.status = "queued";

      await tm.cancelTask(PROJECT_ID as any, "dq-queued" as any);

      // dequeueAvailableTasks should be triggered via tickUpdate
      expect(spy).toHaveBeenCalled();
    });

    it("calls dequeueAvailableTasks after cancelling a retrying task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "dq-retrying", status: "completed" }));

      const tm = new TaskManager(makeConfig());
      await tm.init();

      const spy = vi.spyOn(tm, "dequeueAvailableTasks");

      const task = tm.tasks.get("dq-retrying" as any)!;
      task.data.status = "retrying";
      task.data.nextRetryAt = new Date(Date.now() + 60_000).toISOString();

      await tm.cancelTask(PROJECT_ID as any, "dq-retrying" as any);

      expect(spy).toHaveBeenCalled();
    });

    it("calls dequeueAvailableTasks after cancelling a running task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "dq-running", status: "completed" }));

      const tm = new TaskManager(makeConfig());
      await tm.init();

      const spy = vi.spyOn(tm, "dequeueAvailableTasks");

      const task = tm.tasks.get("dq-running" as any)!;
      task.data.status = "running";
      task.executor = { kill: vi.fn() } as any;

      await tm.cancelTask(PROJECT_ID as any, "dq-running" as any);

      expect(spy).toHaveBeenCalled();
    });
  });

  describe("branchless task recovery", () => {
    it("branchless queued task gets metadata generated during run", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "branchless-task",
        status: "queued",
        branch: null,
        completedAt: null,
      }));

      const tm = new TaskManager(config);

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "fix-bug", title: "Fix Bug", estimatedDurationSeconds: 600 });

      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(true);
      vi.spyOn(project.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      await tm.init();

      // Wait for background processing
      await new Promise((r) => setTimeout(r, 200));

      const task = tm.getTask("branchless-task" as any);
      // Branch should now be set (slug generation happened in doRun)
      expect(task?.branch?.name).toBe("impl/fix-bug-branchless-task");
      expect(task?.title).toBe("Fix Bug");
      // Task ends up failed because acquire was rejected after metadata generation
      expect(task?.data.status).toBe("failed");
    });

    it("metadata generation failure marks task as failed", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "null-branch-task",
        status: "queued",
        branch: null,
        completedAt: null,
      }));

      const tm = new TaskManager(config);

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockRejectedValue(new Error("API error"));
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(true);

      await tm.init();

      await new Promise((r) => setTimeout(r, 200));

      const task = tm.getTask("null-branch-task" as any);
      expect(task?.data.status).toBe("failed");
      expect(task?.data.error).toContain("API error");
    });
  });

  describe("task status transitions", () => {
    it("createNewTask returns status 'queued'", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(new Promise(() => {}));
      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask(PROJECT_ID as any, { prompt: "Add a button" });

      expect(task.data.status).toBe("queued");
      expect(task.branch).toBeUndefined();
      expect(task.id).toBeDefined();
    });

    it("queued task transitions to starting after dequeue", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "add-button", title: "Add a Button", estimatedDurationSeconds: 600 });

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(true);
      vi.spyOn(project.pool, "acquire").mockReturnValue(new Promise(() => {}));

      const task = tm.createNewTask(PROJECT_ID as any, { prompt: "Add a button" });

      // Wait for dequeue + metadata generation
      await new Promise((r) => setTimeout(r, 100));

      expect(tm.getTask(task.id)?.data.status).toBe("starting");
    });

    it("sets runStartedAt when task transitions to starting", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "add-button", title: "Add a Button", estimatedDurationSeconds: 600 });

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(true);
      vi.spyOn(project.pool, "acquire").mockReturnValue(new Promise(() => {}));

      const beforeCreate = new Date();
      const task = tm.createNewTask(PROJECT_ID as any, { prompt: "Add a button" });

      // Wait for dequeue + transition to starting
      await new Promise((r) => setTimeout(r, 100));

      const taskData = tm.getTask(task.id)?.data;
      expect(taskData?.status).toBe("starting");

      // runStartedAt must be set once the task transitions to starting
      expect(taskData?.runStartedAt).toBeDefined();

      // runStartedAt must be >= task creation time
      const runStartedAt = new Date(taskData!.runStartedAt!);
      expect(runStartedAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());

      // runStartedAt must be >= startedAt (queue entry time)
      expect(runStartedAt.getTime()).toBeGreaterThanOrEqual(
        new Date(taskData!.startedAt).getTime()
      );
    });

    it("queued task stays queued when pool has no free slot", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "add-button", title: "Add a Button", estimatedDurationSeconds: 600 });

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask(PROJECT_ID as any, { prompt: "Add a button" });

      await new Promise((r) => setTimeout(r, 100));

      expect(tm.getTask(task.id)?.data.status).toBe("queued");
    });

    it("queued task can be cancelled", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(new Promise(() => {}));
      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask(PROJECT_ID as any, { prompt: "Cancel me" });
      expect(task.data.status).toBe("queued");

      const result = await tm.cancelTask(PROJECT_ID as any, task.id);
      expect(result.data.status).toBe("cancelled");
      expect(result.data.completedAt).toBeDefined();
    });

    it("recoverTask re-enqueues starting tasks as queued", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "starting-task",
        status: "starting" as any,
        branch: null,
        completedAt: null,
        workspaceId: null,
      }));

      const tm = new TaskManager(config);

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      const task = tm.getTask("starting-task" as any);
      expect(task?.data.status).toBe("queued");

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

      tm.tasks.get("starting-task-2" as any)!.data.status = "starting";

      expect(() => tm.retryTask(PROJECT_ID as any, "starting-task-2" as any)).toThrow(TaskActiveError);
    });

    it("listAllTasks includes queued tasks", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockReturnValue(new Promise(() => {}));
      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask(PROJECT_ID as any, { prompt: "Active task" });
      expect(task.data.status).toBe("queued");

      const all = tm.listAllTasks();
      expect(all).toHaveLength(1);
      expect(all[0].data.status).toBe("queued");
    });
  });

  describe("timeout → retrying behavior", () => {
    it("re-enqueues a timeout-retrying task on restart", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeConfig();
      const store = new TaskStore(TMP);

      store.save(makePersistedTask({
        taskId: "timeout-task",
        status: "retrying" as any,
        completedAt: null,
        workspaceId: null,
        attempt: 2,
        branch: "impl/my-feature-timeout-task",
        error: "Timed out after 3600 seconds",
        nextRetryAt: new Date(Date.now() - 10_000).toISOString(), // past due
      }));

      const tm = new TaskManager(config);
      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      const task = tm.getTask("timeout-task" as any);
      // Task should be re-queued (dequeueAvailableTasks promotes past-due retrying tasks)
      expect(task?.data.status).toBe("queued");
      // Attempt counter incremented by promotion
      expect(task?.data.attempt).toBe(3);
      // Branch must be preserved for continuation
      expect(task?.branch?.name).toBe("impl/my-feature-timeout-task");
    });

    it("executeTask sets status to retrying on timeout", async () => {
      const { executeTask } = await import("../src/task-manager/task-runner.js");
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const { Task } = await import("../src/task-manager/task.js");

      const config = makeConfig({
        projects: {
          [PROJECT_ID]: {
            repositories: [{ name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" }],
            claudeCode: { command: "claude", timeoutSeconds: 3600 },
            errorRetry: { maxAttempts: 3, delaySeconds: 60 },
          },
        },
      });
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "build-the-thing", title: "Build the Thing", estimatedDurationSeconds: 600 });

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      const createdTask = tm.createNewTask(PROJECT_ID as any, { prompt: "Build the thing" });
      await new Promise((r) => setTimeout(r, 50));

      const task = tm.tasks.get(createdTask.id)!;
      task.branch = makeBranch("impl/build-the-thing-" + createdTask.id);
      task.data.status = "running";

      // Stub the executor
      vi.spyOn(Executor.prototype, "run").mockResolvedValue({
        exitCode: 137,
        output: "[TIMEOUT] Task exceeded maximum runtime.",
        timedOut: true,
      });

      vi.spyOn(project.pool, "acquire").mockResolvedValue({ id: 0 as any, dir: TMP });
      vi.spyOn(project.pool, "release").mockReturnValue(undefined);
      vi.spyOn(tm.gitManager, "checkoutBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "prepareNewBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "pushBranchAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "getHeadAll").mockResolvedValue(new Map());
      vi.spyOn(tm.gitManager, "hasUncommittedChanges").mockResolvedValue(false);
      vi.spyOn(tm.gitManager, "revertProtectedPathsAll").mockResolvedValue(undefined);
      vi.spyOn(tm.gitManager, "ensureBranchAtHeadAll").mockResolvedValue(false);

      task.executor = new Executor(config.projects[PROJECT_ID as any].data.claudeCode, project.tokenManager, config.server);
      task.workspace = { id: 0 as any, dir: TMP };

      await executeTask(task);

      // Task should be "retrying" after timeout (fail() checks errorRetry config)
      expect(task.data.status).toBe("retrying");
      // Branch must be preserved for the next attempt
      expect(task.branch?.name).toBe("impl/build-the-thing-" + createdTask.id);
    });
  });

  describe("dequeueAvailableTasks queue iteration", () => {
    it("does not skip tasks when pool capacity > 1 and queue has many tasks", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const store = new TaskStore(TMP);

      for (const id of ["task-a", "task-b", "task-c"]) {
        store.save(makePersistedTask({
          taskId: id,
          status: "queued",
          branch: `impl/test-${id}`,
          completedAt: null,
          chainId: `chain-${id}` as any,
        }));
      }

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

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});

      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(true);
      vi.spyOn(project.pool, "acquire").mockImplementation(async () => {
        return { id: 0 as any, dir: TMP };
      });
      vi.spyOn(project.pool, "release").mockReturnValue(undefined);
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

      await new Promise((r) => setTimeout(r, 200));

      // With globalMax=2, at least the first two tasks should have been started
      const tasks = tm.listTasks(PROJECT_ID as any);
      const started = tasks.filter(t => t.data.status !== "queued");
      expect(started.length).toBeGreaterThanOrEqual(2);
    });

    it("queued tasks respect maxConcurrentTasks=1", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const store = new TaskStore(TMP);

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
        server: { workspaceDir: TMP, metaCpus: 0.4, sandboxCpus: 0.4, maxConcurrentTasks: 1 },
        projects: {
          [PROJECT_ID]: {
            maxConcurrentTasks: 1,
            repositories: [{ name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" }],
            claudeCode: { command: "claude" },
          },
        },
      });
      const tm = new TaskManager(config);

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});

      let activeCount = 0;
      let maxObservedActive = 0;

      vi.spyOn(project.pool, "hasFreeSlot").mockImplementation(() => activeCount < 1);
      vi.spyOn(project.pool, "acquire").mockImplementation(async () => {
        activeCount++;
        maxObservedActive = Math.max(maxObservedActive, activeCount);
        return { id: (activeCount - 1) as any, dir: TMP };
      });
      vi.spyOn(project.pool, "release").mockImplementation(() => {
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

      // All 3 tasks must eventually complete
      const tasks = tm.listTasks(PROJECT_ID as any);
      const nonQueued = tasks.filter(t => t.data.status !== "queued");
      expect(nonQueued.length).toBeGreaterThanOrEqual(1);

      // maxConcurrentTasks=1 must be respected
      expect(maxObservedActive).toBeLessThanOrEqual(1);
    });
  });

  describe("bug fixes", () => {
    it("isChainActive detects running tasks in the same chain", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Task } = await import("../src/task-manager/task.js");
      const config = makeConfig({ server: { workspaceDir: TMP, metaCpus: 0.4, sandboxCpus: 0.4, maxConcurrentTasks: 2 } });
      const tm = new TaskManager(config);

      // Create two running tasks in different chains under the same project
      const t1 = new Task(makePersistedTask({ taskId: "t1", status: "running", chainId: "chain-1", completedAt: null }) as any, tm);
      t1.data.status = "running";
      const t2 = new Task(makePersistedTask({ taskId: "t2", status: "running", chainId: "chain-2", completedAt: null }) as any, tm);
      t2.data.status = "running";
      tm.tasks.set("t1" as any, t1);
      tm.tasks.set("t2" as any, t2);

      expect(tm.isChainActive(PROJECT_ID as any, "chain-1" as any)).toBe(true);
      expect(tm.isChainActive(PROJECT_ID as any, "chain-2" as any)).toBe(true);
      expect(tm.isChainActive(PROJECT_ID as any, "chain-3" as any)).toBe(false);
    });

    it("new standalone tasks use prepareNewBranch (not checkoutBranch)", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeConfig();
      const tm = new TaskManager(config);

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "new-task", title: "New Task", estimatedDurationSeconds: 600 });
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(true);
      vi.spyOn(project.pool, "acquire").mockResolvedValue({ id: 0 as any, dir: TMP });
      vi.spyOn(project.pool, "release").mockReturnValue(undefined);

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
      const task = tm.createNewTask(PROJECT_ID as any, { prompt: "Do new thing" });

      await new Promise((r) => setTimeout(r, 100));

      // prepareNewBranchAll should be called (new standalone task)
      expect(prepareSpy).toHaveBeenCalled();
      // checkoutBranchAll should NOT be called
      expect(checkoutSpy).not.toHaveBeenCalled();
    });
  });

  describe("dequeueAvailableTasks triggered on workspace acquisition failure", () => {
    it("calls dequeueAvailableTasks when pool.acquire fails", async () => {
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

      const project = tm.config.projects[PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, 'initialize').mockImplementation(() => {});

      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(true);
      vi.spyOn(project.pool, "acquire").mockRejectedValue(new Error("no workspace available"));
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({ slug: "test", title: "Test", estimatedDurationSeconds: 60 });

      await tm.init();

      await new Promise((r) => setTimeout(r, 200));

      const task = tm.getTask("acquire-fail-task" as any);
      expect(task?.data.status).toBe("failed");
      expect(task?.data.error).toContain("no workspace available");
    });
  });
});

describe("TaskManager - markTaskRead", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("sets readAt on a completed task and persists to disk", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const store = new TaskStore(makeConfig().server.workspaceDir);
    store.save(makePersistedTask({
      taskId: "read-task-1",
      status: "completed",
      completedAt: new Date().toISOString(),
    }));

    const tm = new TaskManager(makeConfig());
    await tm.init();

    const task = tm.markTaskRead("read-task-1" as any);

    expect(task.data.readAt).toBeDefined();
    expect(typeof task.data.readAt).toBe("string");

    // Verify it was persisted to disk
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const raw = readFileSync(join(TMP, "tasks", "read-task-1.json"), "utf-8");
    const persisted = JSON.parse(raw);
    expect(persisted.readAt).toBe(task.data.readAt);
  });

  it("is idempotent - calling markTaskRead twice preserves first readAt", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const store = new TaskStore(makeConfig().server.workspaceDir);
    store.save(makePersistedTask({
      taskId: "read-task-2",
      status: "completed",
      completedAt: new Date().toISOString(),
    }));

    const tm = new TaskManager(makeConfig());
    await tm.init();

    const task = tm.markTaskRead("read-task-2" as any);
    const firstReadAt = task.data.readAt;

    await new Promise((r) => setTimeout(r, 10));

    tm.markTaskRead("read-task-2" as any);
    expect(task.data.readAt).toBe(firstReadAt);
  });

  it("throws when task is not found", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const tm = new TaskManager(makeConfig());
    await tm.init();

    expect(() => tm.markTaskRead("nonexistent" as any)).toThrow("Task not found: nonexistent");
  });

  it("survives reload - readAt persisted to disk and re-loaded", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const store = new TaskStore(makeConfig().server.workspaceDir);
    store.save(makePersistedTask({
      taskId: "read-task-3",
      status: "completed",
      completedAt: new Date().toISOString(),
    }));

    const tm1 = new TaskManager(makeConfig());
    await tm1.init();
    const task = tm1.markTaskRead("read-task-3" as any);
    const savedReadAt = task.data.readAt;

    // Create a new task manager to simulate restart
    const tm2 = new TaskManager(makeConfig());
    await tm2.init();

    const reloadedTask = tm2.getTask("read-task-3" as any);
    expect(reloadedTask?.data.readAt).toBe(savedReadAt);
  });
});
