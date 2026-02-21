import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TaskStore } from "./task-store.js";
import type { PersistedTask } from "./types.js";

const TMP = join(import.meta.dirname, "..", "tmp", "task-store-test");

function makeTask(overrides: Partial<PersistedTask> = {}): PersistedTask {
  return {
    taskId: "abc123",
    projectId: "test-project",
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

describe("TaskStore", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("creates tasks directory on construction", () => {
    new TaskStore(TMP);
    expect(existsSync(join(TMP, "tasks"))).toBe(true);
  });

  it("save() writes a JSON file to disk", () => {
    const store = new TaskStore(TMP);
    const task = makeTask();

    store.save(task);

    const filePath = join(TMP, "tasks", "abc123.json");
    expect(existsSync(filePath)).toBe(true);

    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.taskId).toBe("abc123");
    expect(parsed.workspaceId).toBe(0);
    expect(parsed.status).toBe("completed");
  });

  it("save() overwrites existing file", () => {
    const store = new TaskStore(TMP);
    const task = makeTask({ status: "running" });

    store.save(task);
    task.status = "completed";
    store.save(task);

    const filePath = join(TMP, "tasks", "abc123.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(parsed.status).toBe("completed");
  });

  it("loadAll() returns saved tasks", () => {
    const store = new TaskStore(TMP);

    store.save(makeTask({ taskId: "task-1", workspaceId: 0 }));
    store.save(makeTask({ taskId: "task-2", workspaceId: 1 }));

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(2);

    const ids = loaded.map((t) => t.taskId).sort();
    expect(ids).toEqual(["task-1", "task-2"]);
  });

  it("loadAll() returns empty array when no tasks exist", () => {
    const store = new TaskStore(TMP);
    const loaded = store.loadAll();
    expect(loaded).toEqual([]);
  });

  it("loadAll() skips corrupted JSON files", () => {
    const store = new TaskStore(TMP);

    store.save(makeTask({ taskId: "good-task" }));

    // Write a corrupted file
    writeFileSync(join(TMP, "tasks", "bad-task.json"), "not valid json{{{");

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].taskId).toBe("good-task");
  });

  it("loadAll() skips files without taskId", () => {
    const store = new TaskStore(TMP);

    store.save(makeTask({ taskId: "valid-task" }));

    // Write a valid JSON but without taskId
    writeFileSync(join(TMP, "tasks", "empty.json"), JSON.stringify({ status: "completed" }));

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].taskId).toBe("valid-task");
  });

  it("loadAll() ignores non-JSON files", () => {
    const store = new TaskStore(TMP);
    store.save(makeTask({ taskId: "real-task" }));

    writeFileSync(join(TMP, "tasks", "notes.txt"), "some random file");

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].taskId).toBe("real-task");
  });

  it("save() does not leave .tmp files on success", () => {
    const store = new TaskStore(TMP);
    store.save(makeTask({ taskId: "clean-task" }));

    const files = require("node:fs").readdirSync(join(TMP, "tasks")) as string[];
    const tmpFiles = files.filter((f: string) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("loadAll() skips files without workspaceId", () => {
    const store = new TaskStore(TMP);

    store.save(makeTask({ taskId: "valid-task" }));

    // Write a valid JSON with taskId but missing workspaceId
    writeFileSync(
      join(TMP, "tasks", "no-ws.json"),
      JSON.stringify({ taskId: "no-ws", status: "completed", prompt: "test" }),
    );

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].taskId).toBe("valid-task");
  });

  it("round-trips all task fields correctly", () => {
    const store = new TaskStore(TMP);
    const task = makeTask({
      taskId: "rt-test",
      projectId: "my-project",
      branch: "impl/round-trip-rt-test",
      prompt: "Implement dark mode",
      status: "failed",
      startedAt: "2025-06-01T12:00:00.000Z",
      completedAt: "2025-06-01T13:30:00.000Z",
      output: "Error occurred",
      error: "Claude Code exited with code 1",
      workspaceId: 3,
    });

    store.save(task);
    const loaded = store.loadAll();

    expect(loaded).toHaveLength(1);
    const rt = loaded[0];
    expect(rt.taskId).toBe("rt-test");
    expect(rt.projectId).toBe("my-project");
    expect(rt.branch).toBe("impl/round-trip-rt-test");
    expect(rt.prompt).toBe("Implement dark mode");
    expect(rt.status).toBe("failed");
    expect(rt.startedAt).toBe("2025-06-01T12:00:00.000Z");
    expect(rt.completedAt).toBe("2025-06-01T13:30:00.000Z");
    expect(rt.output).toBe("Error occurred");
    expect(rt.error).toBe("Claude Code exited with code 1");
    expect(rt.workspaceId).toBe(3);
  });

  it("loadAll() skips files without projectId", () => {
    const store = new TaskStore(TMP);

    store.save(makeTask({ taskId: "valid-task" }));

    // Write a valid JSON with taskId and workspaceId but missing projectId
    writeFileSync(
      join(TMP, "tasks", "no-project.json"),
      JSON.stringify({ taskId: "no-project", workspaceId: 0, status: "completed" }),
    );

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].taskId).toBe("valid-task");
  });
});
