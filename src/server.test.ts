import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import type { TaskManager } from "./task-manager.js";
import type { Task } from "./types.js";
import { PoolExhaustedError } from "./workspace-pool.js";

function makeMockTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: "abc123",
    branch: "impl/test-branch-abc123",
    prompt: "Add a button",
    status: "running",
    startedAt: "2025-01-01T00:00:00.000Z",
    completedAt: null,
    output: "",
    ...overrides,
  };
}

function makeMockTaskManager(overrides: Partial<TaskManager> = {}) {
  return {
    startTask: vi.fn(),
    getTask: vi.fn(),
    listTasks: vi.fn().mockReturnValue([]),
    getOutput: vi.fn().mockReturnValue(""),
    ...overrides,
  } as unknown as TaskManager;
}

describe("server", () => {
  describe("GET /docs", () => {
    it("returns Swagger UI HTML", async () => {
      const app = createServer(makeMockTaskManager());
      const res = await request(app).get("/docs/").expect(200);
      expect(res.text).toContain("swagger");
    });
  });

  describe("GET /", () => {
    it("redirects to /docs", async () => {
      const app = createServer(makeMockTaskManager());
      const res = await request(app).get("/").expect(302);
      expect(res.headers.location).toBe("/docs");
    });
  });

  describe("POST /task", () => {
    it("creates a task and returns taskId", async () => {
      const task = makeMockTask();
      const tm = makeMockTaskManager({
        startTask: vi.fn().mockResolvedValue(task),
      });
      const app = createServer(tm);

      const res = await request(app)
        .post("/task")
        .send({ prompt: "Add a button" })
        .expect(200);

      expect(res.body.taskId).toBe("abc123");
      expect(res.body.branch).toBe("impl/test-branch-abc123");
      expect(res.body.status).toBe("running");
    });

    it("rejects empty prompt", async () => {
      const app = createServer(makeMockTaskManager());
      await request(app).post("/task").send({ prompt: "" }).expect(400);
    });

    it("rejects missing prompt", async () => {
      const app = createServer(makeMockTaskManager());
      await request(app).post("/task").send({}).expect(400);
    });

    it("returns 429 when pool exhausted", async () => {
      const tm = makeMockTaskManager({
        startTask: vi.fn().mockRejectedValue(new PoolExhaustedError()),
      });
      const app = createServer(tm);

      const res = await request(app)
        .post("/task")
        .send({ prompt: "Do something" })
        .expect(429);

      expect(res.body.error).toContain("Maximum concurrent tasks");
    });

    it("returns 500 on unexpected error", async () => {
      const tm = makeMockTaskManager({
        startTask: vi.fn().mockRejectedValue(new Error("boom")),
      });
      const app = createServer(tm);

      const res = await request(app)
        .post("/task")
        .send({ prompt: "Do something" })
        .expect(500);

      expect(res.body.error).toBe("boom");
    });
  });

  describe("GET /tasks", () => {
    it("returns empty list when no tasks", async () => {
      const app = createServer(makeMockTaskManager());
      const res = await request(app).get("/tasks").expect(200);
      expect(res.body.tasks).toEqual([]);
    });

    it("returns task list", async () => {
      const task = makeMockTask({ status: "completed", completedAt: "2025-01-01T01:00:00.000Z" });
      const tm = makeMockTaskManager({
        listTasks: vi.fn().mockReturnValue([task]),
      });
      const app = createServer(tm);

      const res = await request(app).get("/tasks").expect(200);
      expect(res.body.tasks).toHaveLength(1);
      expect(res.body.tasks[0].taskId).toBe("abc123");
      expect(res.body.tasks[0].status).toBe("completed");
    });
  });

  describe("GET /task/:taskId", () => {
    it("returns task status", async () => {
      const task = makeMockTask();
      const tm = makeMockTaskManager({
        getTask: vi.fn().mockReturnValue(task),
      });
      const app = createServer(tm);

      const res = await request(app).get("/task/abc123").expect(200);
      expect(res.body.taskId).toBe("abc123");
      expect(res.body.prompt).toBe("Add a button");
    });

    it("returns 404 for unknown task", async () => {
      const tm = makeMockTaskManager({
        getTask: vi.fn().mockReturnValue(undefined),
      });
      const app = createServer(tm);

      await request(app).get("/task/nonexistent").expect(404);
    });
  });

  describe("GET /task/:taskId/log", () => {
    it("returns task output", async () => {
      const task = makeMockTask();
      const tm = makeMockTaskManager({
        getTask: vi.fn().mockReturnValue(task),
        getOutput: vi.fn().mockReturnValue("Hello from Claude"),
      });
      const app = createServer(tm);

      const res = await request(app).get("/task/abc123/log").expect(200);
      expect(res.body.output).toBe("Hello from Claude");
      expect(res.body.truncated).toBe(false);
    });

    it("returns 404 for unknown task", async () => {
      const tm = makeMockTaskManager({
        getTask: vi.fn().mockReturnValue(undefined),
      });
      const app = createServer(tm);

      await request(app).get("/task/nonexistent/log").expect(404);
    });
  });

  describe("authentication", () => {
    it("rejects requests without API key when configured", async () => {
      const original = process.env.API_KEY;
      process.env.API_KEY = "test-secret";
      try {
        const app = createServer(makeMockTaskManager());
        await request(app).get("/tasks").expect(401);
      } finally {
        if (original === undefined) {
          delete process.env.API_KEY;
        } else {
          process.env.API_KEY = original;
        }
      }
    });

    it("accepts requests with correct API key", async () => {
      const original = process.env.API_KEY;
      process.env.API_KEY = "test-secret";
      try {
        const app = createServer(makeMockTaskManager());
        await request(app)
          .get("/tasks")
          .set("Authorization", "Bearer test-secret")
          .expect(200);
      } finally {
        if (original === undefined) {
          delete process.env.API_KEY;
        } else {
          process.env.API_KEY = original;
        }
      }
    });

    it("allows /docs without API key", async () => {
      const original = process.env.API_KEY;
      process.env.API_KEY = "test-secret";
      try {
        const app = createServer(makeMockTaskManager());
        await request(app).get("/docs/").expect(200);
      } finally {
        if (original === undefined) {
          delete process.env.API_KEY;
        } else {
          process.env.API_KEY = original;
        }
      }
    });
  });
});
