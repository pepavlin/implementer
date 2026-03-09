/**
 * Tests for task priority ordering and global pause/resume functionality.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PersistedTask } from "../src/types.js";
import type { Config } from "../src/config/config.js";
import { Project } from "../src/config/project.js";
import type { ProjectConfig } from "../src/config/config-types.js";
import { TaskStore } from "../src/task-store.js";
import { PRIORITY_WEIGHT } from "../src/types.js";

const TMP = join(import.meta.dirname, "..", "tmp", "priority-pause-test");
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
      claudeCode: { command: "claude" },
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

function makePersistedTask(overrides: Partial<any> = {}): PersistedTask {
  return {
    taskId: "abc123",
    projectId: PROJECT_ID,
    prompt: "Add a button",
    status: "completed",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    output: "Done",
    workspaceId: undefined,
    attempt: 1,
    chainId: "chain-abc123",
    priority: "normal",
    ...overrides,
  } as any;
}

describe("TaskPriority", () => {
  describe("PRIORITY_WEIGHT constants", () => {
    it("defines numeric weights for all priority levels", () => {
      expect(PRIORITY_WEIGHT.low).toBe(0);
      expect(PRIORITY_WEIGHT.normal).toBe(1);
      expect(PRIORITY_WEIGHT.high).toBe(2);
      expect(PRIORITY_WEIGHT.critical).toBe(3);
    });

    it("critical > high > normal > low", () => {
      expect(PRIORITY_WEIGHT.critical).toBeGreaterThan(PRIORITY_WEIGHT.high);
      expect(PRIORITY_WEIGHT.high).toBeGreaterThan(PRIORITY_WEIGHT.normal);
      expect(PRIORITY_WEIGHT.normal).toBeGreaterThan(PRIORITY_WEIGHT.low);
    });
  });

  describe("TaskManager.createNewTask priority", () => {
    beforeEach(() => {
      rmSync(TMP, { recursive: true, force: true });
      mkdirSync(TMP, { recursive: true });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      rmSync(TMP, { recursive: true, force: true });
    });

    it("defaults to 'normal' priority when not specified", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Task } = await import("../src/task-manager/task.js");
      vi.spyOn(Task.prototype, "run").mockImplementation(function(this: any) {
        const idx = this.manager.queue.indexOf(this.data.taskId);
        if (idx !== -1) this.manager.queue.splice(idx, 1);
        this.data.status = "starting";
      });

      const tm = new TaskManager(makeConfig());
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "t1", status: "queued", priority: "normal" }));
      await tm.init();

      const task = tm.getTask("t1" as any);
      expect(task?.data.priority).toBe("normal");
    });

    it("persists 'high' priority correctly", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "t-high", status: "queued", priority: "high" }));

      const tm = new TaskManager(makeConfig());
      await tm.init();

      const task = tm.getTask("t-high" as any);
      expect(task?.data.priority).toBe("high");
    });

    it("persists 'critical' priority correctly", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "t-crit", status: "queued", priority: "critical" }));

      const tm = new TaskManager(makeConfig());
      await tm.init();

      const task = tm.getTask("t-crit" as any);
      expect(task?.data.priority).toBe("critical");
    });

    it("persists 'low' priority correctly", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const store = new TaskStore(TMP);
      store.save(makePersistedTask({ taskId: "t-low", status: "queued", priority: "low" }));

      const tm = new TaskManager(makeConfig());
      await tm.init();

      const task = tm.getTask("t-low" as any);
      expect(task?.data.priority).toBe("low");
    });
  });
});

describe("TaskStore backward compatibility", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("defaults priority to 'normal' for tasks persisted without priority field", () => {
    const store = new TaskStore(TMP);
    // Save a task without priority field (simulating old format)
    const taskWithoutPriority = makePersistedTask({ taskId: "old-task" });
    delete (taskWithoutPriority as any).priority;
    store.save(taskWithoutPriority);

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].priority).toBe("normal");
  });

  it("preserves existing priority on load", () => {
    const store = new TaskStore(TMP);
    store.save(makePersistedTask({ taskId: "t-prio", priority: "critical" }));

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].priority).toBe("critical");
  });
});

describe("TaskManager pause/resume", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("starts in unpaused state", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const tm = new TaskManager(makeConfig());
    expect(tm.isPaused()).toBe(false);
  });

  it("pause() sets paused state to true", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const tm = new TaskManager(makeConfig());
    tm.pause();
    expect(tm.isPaused()).toBe(true);
  });

  it("resume() clears paused state", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const tm = new TaskManager(makeConfig());
    tm.pause();
    expect(tm.isPaused()).toBe(true);
    tm.resume();
    expect(tm.isPaused()).toBe(false);
  });

  it("pause() is idempotent - calling twice keeps paused", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const tm = new TaskManager(makeConfig());
    tm.pause();
    tm.pause();
    expect(tm.isPaused()).toBe(true);
  });

  it("resume() when already unpaused stays unpaused", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const tm = new TaskManager(makeConfig());
    tm.resume(); // should not throw
    expect(tm.isPaused()).toBe(false);
  });

  it("when paused, dequeueAvailableTasks does not start queued tasks", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const { Task } = await import("../src/task-manager/task.js");

    const tm = new TaskManager(makeConfig());
    tm.pause(); // Pause BEFORE init so tasks aren't started during init

    const store = new TaskStore(TMP);
    store.save(makePersistedTask({
      taskId: "queued-task",
      status: "queued",
      priority: "normal"
    }));

    // Spy on Task.run
    const runSpy = vi.spyOn(Task.prototype, "run").mockImplementation(function(this: any) {
      const idx = this.manager.queue.indexOf(this.data.taskId);
      if (idx !== -1) this.manager.queue.splice(idx, 1);
      this.data.status = "starting";
    });

    await tm.init();

    // run() should NOT have been called because we're paused
    expect(runSpy).not.toHaveBeenCalled();

    // Explicit dequeue call while paused also should not start tasks
    tm.dequeueAvailableTasks();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("when resumed, dequeueAvailableTasks attempts to start queued tasks", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const { Task } = await import("../src/task-manager/task.js");

    const tm = new TaskManager(makeConfig());
    tm.pause(); // Pause BEFORE init

    const store = new TaskStore(TMP);
    store.save(makePersistedTask({
      taskId: "queued-task-2",
      status: "queued",
      priority: "normal"
    }));

    const runSpy = vi.spyOn(Task.prototype, "run").mockImplementation(function(this: any) {
      const idx = this.manager.queue.indexOf(this.data.taskId);
      if (idx !== -1) this.manager.queue.splice(idx, 1);
      this.data.status = "starting";
    });

    await tm.init();

    // run() should NOT have been called because we're paused
    expect(runSpy).not.toHaveBeenCalled();

    // Now resume
    tm.resume();

    // run() should have been called (dequeueAvailableTasks called inside resume)
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Priority-based dequeue ordering", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("dequeues higher priority tasks before lower priority tasks", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const { Task } = await import("../src/task-manager/task.js");

    const tm = new TaskManager(makeConfig({ server: { maxConcurrentTasks: 1 } }));
    const store = new TaskStore(TMP);

    // Enqueue tasks in reverse priority order (low first, high last)
    const now = new Date();
    store.save(makePersistedTask({
      taskId: "low-task",
      status: "queued",
      priority: "low",
      createdAt: new Date(now.getTime() + 1000).toISOString()
    }));
    store.save(makePersistedTask({
      taskId: "normal-task",
      status: "queued",
      priority: "normal",
      createdAt: new Date(now.getTime() + 2000).toISOString()
    }));
    store.save(makePersistedTask({
      taskId: "high-task",
      status: "queued",
      priority: "high",
      createdAt: new Date(now.getTime() + 3000).toISOString()
    }));

    const runOrder: string[] = [];
    vi.spyOn(Task.prototype, "run").mockImplementation(function(this: any) {
      runOrder.push(this.id);
      // Mark as starting to consume the one concurrent slot
      this.data.status = "starting";
    });

    await tm.init();

    // With maxConcurrentTasks=1, only one task should have been started
    // and it should be the highest priority one
    expect(runOrder).toHaveLength(1);
    expect(runOrder[0]).toBe("high-task");
  });

  it("dequeues critical before high before normal before low", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const { Task } = await import("../src/task-manager/task.js");

    // Allow up to 4 concurrent tasks so all tasks are started in one dequeue pass
    const tm = new TaskManager(makeConfig({ server: { maxConcurrentTasks: 4 } }));
    const store = new TaskStore(TMP);

    const now = new Date();
    // Insert in non-priority order
    store.save(makePersistedTask({ taskId: "normal-task", status: "queued", priority: "normal", createdAt: new Date(now.getTime() + 1000).toISOString() }));
    store.save(makePersistedTask({ taskId: "critical-task", status: "queued", priority: "critical", createdAt: new Date(now.getTime() + 2000).toISOString() }));
    store.save(makePersistedTask({ taskId: "low-task", status: "queued", priority: "low", createdAt: new Date(now.getTime() + 3000).toISOString() }));
    store.save(makePersistedTask({ taskId: "high-task", status: "queued", priority: "high", createdAt: new Date(now.getTime() + 4000).toISOString() }));

    const runOrder: string[] = [];
    vi.spyOn(Task.prototype, "run").mockImplementation(function(this: any) {
      runOrder.push(this.id);
    });

    await tm.init();

    // All 4 tasks should have been started (maxConcurrentTasks=4)
    expect(runOrder).toHaveLength(4);

    // Verify critical is before high, high before normal, normal before low
    expect(runOrder.indexOf("critical-task")).toBeLessThan(runOrder.indexOf("high-task"));
    expect(runOrder.indexOf("high-task")).toBeLessThan(runOrder.indexOf("normal-task"));
    expect(runOrder.indexOf("normal-task")).toBeLessThan(runOrder.indexOf("low-task"));
  });

  it("tasks with same priority respect FIFO order", async () => {
    const { TaskManager } = await import("../src/task-manager/task-manager.js");
    const { Task } = await import("../src/task-manager/task.js");

    // Allow only 1 concurrent task to see which goes first
    const tm = new TaskManager(makeConfig({ server: { maxConcurrentTasks: 1 } }));
    const store = new TaskStore(TMP);

    const now = new Date();
    // Both are "high" priority; task A was created first
    store.save(makePersistedTask({ taskId: "high-task-a", status: "queued", priority: "high", createdAt: new Date(now.getTime()).toISOString() }));
    store.save(makePersistedTask({ taskId: "high-task-b", status: "queued", priority: "high", createdAt: new Date(now.getTime() + 5000).toISOString() }));

    const runOrder: string[] = [];
    vi.spyOn(Task.prototype, "run").mockImplementation(function(this: any) {
      runOrder.push(this.id);
      this.data.status = "starting";
    });

    await tm.init();

    // Only one task should have started; it should be the earlier one (FIFO)
    expect(runOrder).toHaveLength(1);
    expect(runOrder[0]).toBe("high-task-a");
  });
});
