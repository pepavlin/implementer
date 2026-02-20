import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import type { TaskManager } from "./task-manager.js";
import type { Config, Task } from "./types.js";
import { PoolExhaustedError } from "./workspace-pool.js";
import { GlobalConcurrencyLimitError } from "./task-manager.js";
import { UsageLimitError } from "./usage-limiter.js";

const PROJECT_ID = "test-project";

function makeConfig(projectOverrides: Record<string, unknown> = {}): Config {
    return {
        server: { workspaceDir: "/tmp/test" },
        projects: {
            [PROJECT_ID]: {
                repositories: [
                    {
                        name: "repo",
                        url: "https://example.com/repo.git",
                        defaultBranch: "main"
                    }
                ],
                claudeCode: { command: "claude" },
                ...projectOverrides
            }
        }
    };
}

function makeMockTask(overrides: Partial<Task> = {}): Task {
    return {
        taskId: "abc123",
        projectId: PROJECT_ID,
        branch: "impl/test-branch-abc123",
        prompt: "Add a button",
        status: "running",
        startedAt: "2025-01-01T00:00:00.000Z",
        completedAt: null,
        output: "",
        ...overrides
    };
}

function makeMockTaskManager(overrides: Partial<TaskManager> = {}) {
    return {
        startTask: vi.fn(),
        getTask: vi.fn(),
        listTasks: vi.fn().mockReturnValue([]),
        getOutput: vi.fn().mockReturnValue(""),
        ...overrides
    } as unknown as TaskManager;
}

describe("server", () => {
    describe("GET /docs", () => {
        it("returns Swagger UI HTML", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            const res = await request(app).get("/docs/").expect(200);
            expect(res.text).toContain("swagger");
        });
    });

    describe("GET /", () => {
        it("redirects to /docs", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            const res = await request(app).get("/").expect(302);
            expect(res.headers.location).toBe("/docs");
        });
    });

    describe("POST /task", () => {
        it("creates a task and returns taskId", async () => {
            const task = makeMockTask();
            const tm = makeMockTaskManager({
                startTask: vi.fn().mockResolvedValue(task)
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app)
                .post("/task")
                .send({ prompt: "Add a button" })
                .expect(200);

            expect(res.body.taskId).toBe("abc123");
            expect(res.body.branch).toBe("impl/test-branch-abc123");
            expect(res.body.status).toBe("running");
        });

        it("rejects empty prompt", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            await request(app).post("/task").send({ prompt: "" }).expect(400);
        });

        it("rejects missing prompt", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            await request(app).post("/task").send({}).expect(400);
        });

        it("returns 429 when pool exhausted", async () => {
            const tm = makeMockTaskManager({
                startTask: vi.fn().mockRejectedValue(new PoolExhaustedError(4))
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app)
                .post("/task")
                .send({ prompt: "Do something" })
                .expect(429);

            expect(res.body.error).toContain("Maximum concurrent tasks");
        });

        it("returns 429 when global concurrent task limit is reached", async () => {
            const tm = makeMockTaskManager({
                startTask: vi
                    .fn()
                    .mockRejectedValue(new GlobalConcurrencyLimitError(10))
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app)
                .post("/task")
                .send({ prompt: "Do something" })
                .expect(429);

            expect(res.body.error).toContain("Global concurrent task limit");
        });

        it("returns 429 when token usage limit is exceeded", async () => {
            const tm = makeMockTaskManager({
                startTask: vi
                    .fn()
                    .mockRejectedValue(new UsageLimitError(600_000, 500_000))
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app)
                .post("/task")
                .send({ prompt: "Do something" })
                .expect(429);

            expect(res.body.error).toContain("Token usage limit exceeded");
        });

        it("returns 500 on unexpected error", async () => {
            const tm = makeMockTaskManager({
                startTask: vi.fn().mockRejectedValue(new Error("boom"))
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app)
                .post("/task")
                .send({ prompt: "Do something" })
                .expect(500);

            expect(res.body.error).toBe("boom");
        });
    });

    describe("GET /tasks", () => {
        it("returns empty list when no tasks", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            const res = await request(app).get("/tasks").expect(200);
            expect(res.body.tasks).toEqual([]);
        });

        it("returns task list with durationSeconds", async () => {
            const task = makeMockTask({
                status: "completed",
                completedAt: "2025-01-01T01:00:00.000Z"
            });
            const tm = makeMockTaskManager({
                listTasks: vi.fn().mockReturnValue([task])
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).get("/tasks").expect(200);
            expect(res.body.tasks).toHaveLength(1);
            expect(res.body.tasks[0].taskId).toBe("abc123");
            expect(res.body.tasks[0].status).toBe("completed");
            expect(res.body.tasks[0].durationSeconds).toBe(3600);
        });
    });

    describe("GET /task/:taskId", () => {
        it("returns task status with durationSeconds", async () => {
            const task = makeMockTask({
                status: "completed",
                completedAt: "2025-01-01T00:05:00.000Z"
            });
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(task)
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).get("/task/abc123").expect(200);
            expect(res.body.taskId).toBe("abc123");
            expect(res.body.prompt).toBe("Add a button");
            expect(res.body.durationSeconds).toBe(300);
        });

        it("returns pullRequests when present", async () => {
            const task = makeMockTask({
                status: "completed",
                completedAt: "2025-01-01T00:05:00.000Z",
                pullRequests: [
                    {
                        repo: "my-repo",
                        url: "https://github.com/org/repo/pull/42"
                    }
                ]
            });
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(task)
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).get("/task/abc123").expect(200);
            expect(res.body.pullRequests).toEqual([
                { repo: "my-repo", url: "https://github.com/org/repo/pull/42" }
            ]);
        });

        it("returns null pullRequests when not present", async () => {
            const task = makeMockTask({
                status: "completed",
                completedAt: "2025-01-01T00:05:00.000Z"
            });
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(task)
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).get("/task/abc123").expect(200);
            expect(res.body.pullRequests).toBeNull();
        });

        it("returns growing durationSeconds for running task", async () => {
            const now = new Date();
            const fiveSecondsAgo = new Date(now.getTime() - 5000).toISOString();
            const task = makeMockTask({
                startedAt: fiveSecondsAgo,
                completedAt: null
            });
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(task)
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).get("/task/abc123").expect(200);
            expect(res.body.durationSeconds).toBeGreaterThanOrEqual(4);
            expect(res.body.durationSeconds).toBeLessThanOrEqual(10);
        });

        it("returns null output for interrupted task", async () => {
            const task = makeMockTask({
                status: "interrupted" as any,
                completedAt: null
            });
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(task)
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).get("/task/abc123").expect(200);
            expect(res.body.status).toBe("interrupted");
            expect(res.body.output).toBeNull();
        });

        it("returns 404 for unknown task", async () => {
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(undefined)
            });
            const app = createServer(tm, makeConfig());

            await request(app).get("/task/nonexistent").expect(404);
        });
    });

    describe("GET /task/:taskId/log", () => {
        it("returns task output", async () => {
            const task = makeMockTask();
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(task),
                getOutput: vi.fn().mockReturnValue("Hello from Claude")
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).get("/task/abc123/log").expect(200);
            expect(res.body.output).toBe("Hello from Claude");
            expect(res.body.truncated).toBe(false);
        });

        it("returns 404 for unknown task", async () => {
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(undefined)
            });
            const app = createServer(tm, makeConfig());

            await request(app).get("/task/nonexistent/log").expect(404);
        });
    });

    describe("authentication", () => {
        it("rejects requests without API key when configured", async () => {
            const app = createServer(
                makeMockTaskManager(),
                makeConfig({ apiKey: "test-secret" })
            );
            await request(app).get("/tasks").expect(401);
        });

        it("accepts requests with correct API key", async () => {
            const app = createServer(
                makeMockTaskManager(),
                makeConfig({ apiKey: "test-secret" })
            );
            await request(app)
                .get("/tasks")
                .set("Authorization", "Bearer test-secret")
                .expect(200);
        });

        it("rejects requests with wrong API key", async () => {
            const app = createServer(
                makeMockTaskManager(),
                makeConfig({ apiKey: "test-secret" })
            );
            await request(app)
                .get("/tasks")
                .set("Authorization", "Bearer wrong-key")
                .expect(401);
        });

        it("allows /docs without API key even when auth is configured", async () => {
            const app = createServer(
                makeMockTaskManager(),
                makeConfig({ apiKey: "test-secret" })
            );
            await request(app).get("/docs/").expect(200);
        });

        it("allows requests without API key in dev mode (single project, no apiKey)", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig()); // no apiKey
            await request(app).get("/tasks").expect(200);
        });

        it("rejects when multiple projects configured but no API keys", async () => {
            const config: Config = {
                server: { workspaceDir: "/tmp/test" },
                projects: {
                    "project-a": {
                        repositories: [
                            {
                                name: "repo-a",
                                url: "https://example.com/a.git",
                                defaultBranch: "main"
                            }
                        ],
                        claudeCode: { command: "claude" }
                    },
                    "project-b": {
                        repositories: [
                            {
                                name: "repo-b",
                                url: "https://example.com/b.git",
                                defaultBranch: "main"
                            }
                        ],
                        claudeCode: { command: "claude" }
                    }
                }
            };
            const app = createServer(makeMockTaskManager(), config);
            await request(app).get("/tasks").expect(401);
        });
    });
});
