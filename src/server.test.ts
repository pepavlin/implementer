import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import type { TaskManager } from "./task-manager.js";
import type { Config, Task } from "./types.js";
import { UsageLimitError } from "./usage-limiter.js";
import { TaskActiveError } from "./task-manager.js";

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
        attempt: 1,
        ...overrides
    };
}

function makeMockTaskManager(overrides: Partial<TaskManager> = {}) {
    return {
        startTask: vi.fn(),
        getTask: vi.fn(),
        listTasks: vi.fn().mockReturnValue([]),
        listAllActiveTasks: vi.fn().mockReturnValue([]),
        listAllTasks: vi.fn().mockReturnValue([]),
        getOutput: vi.fn().mockReturnValue(""),
        retryTask: vi.fn(),
        ...overrides
    } as unknown as TaskManager;
}

function makeConfigWithAdmin(): Config {
    return {
        server: { workspaceDir: "/tmp/test", adminPassword: "secret" },
        projects: {
            [PROJECT_ID]: {
                repositories: [{ name: "repo", url: "https://example.com/repo.git", defaultBranch: "main" }],
                claudeCode: { command: "claude" }
            }
        }
    };
}

async function getAdminCookie(app: ReturnType<typeof createServer>): Promise<string> {
    const loginRes = await request(app)
        .post("/dashboard")
        .type("form")
        .send({ password: "secret" })
        .expect(302);
    const setCookie = loginRes.headers["set-cookie"] as string[] | string;
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return cookieHeader?.split(";")[0] ?? "";
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
        it("creates a task and returns taskId with queued status and null branch", async () => {
            const task = makeMockTask({ status: "queued", branch: null });
            const tm = makeMockTaskManager({
                startTask: vi.fn().mockResolvedValue(task)
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app)
                .post("/task")
                .send({ prompt: "Add a button" })
                .expect(200);

            expect(res.body.taskId).toBe("abc123");
            expect(res.body.branch).toBeNull();
            expect(res.body.status).toBe("queued");
        });

        it("rejects empty prompt", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            await request(app).post("/task").send({ prompt: "" }).expect(400);
        });

        it("rejects missing prompt", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            await request(app).post("/task").send({}).expect(400);
        });

        it("returns queued status when at capacity", async () => {
            const task = makeMockTask({ status: "queued" });
            const tm = makeMockTaskManager({
                startTask: vi.fn().mockResolvedValue(task)
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app)
                .post("/task")
                .send({ prompt: "Do something" })
                .expect(200);

            expect(res.body.status).toBe("queued");
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

        it("accepts pullRequestNumber as integer and passes it to startTask", async () => {
            const task = makeMockTask({ status: "queued", branch: null, pullRequestNumber: 42 });
            const startTask = vi.fn().mockResolvedValue(task);
            const tm = makeMockTaskManager({ startTask });
            const app = createServer(tm, makeConfig());

            const res = await request(app)
                .post("/task")
                .send({ prompt: "Fix bug", pullRequestNumber: 42 })
                .expect(200);

            expect(res.body.taskId).toBe("abc123");
            expect(startTask).toHaveBeenCalledWith(expect.any(String), {
                prompt: "Fix bug",
                pullRequestNumber: 42
            });
        });

        it("rejects non-integer pullRequestNumber", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            await request(app)
                .post("/task")
                .send({ prompt: "Fix bug", pullRequestNumber: "not-a-number" })
                .expect(400);
        });

        it("rejects negative pullRequestNumber", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            await request(app)
                .post("/task")
                .send({ prompt: "Fix bug", pullRequestNumber: -1 })
                .expect(400);
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

        it("filters tasks by single status", async () => {
            const running = makeMockTask({ taskId: "t1", status: "running" });
            const completed = makeMockTask({
                taskId: "t2",
                status: "completed",
                completedAt: "2025-01-01T01:00:00.000Z"
            });
            const tm = makeMockTaskManager({
                listTasks: vi.fn().mockReturnValue([running, completed])
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).get("/tasks?status=running").expect(200);
            expect(res.body.tasks).toHaveLength(1);
            expect(res.body.tasks[0].taskId).toBe("t1");
            expect(res.body.tasks[0].status).toBe("running");
        });

        it("filters tasks by multiple statuses", async () => {
            const running = makeMockTask({ taskId: "t1", status: "running" });
            const queued = makeMockTask({ taskId: "t2", status: "queued" });
            const completed = makeMockTask({
                taskId: "t3",
                status: "completed",
                completedAt: "2025-01-01T01:00:00.000Z"
            });
            const tm = makeMockTaskManager({
                listTasks: vi.fn().mockReturnValue([running, queued, completed])
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app)
                .get("/tasks?status=running&status=queued")
                .expect(200);
            expect(res.body.tasks).toHaveLength(2);
            expect(res.body.tasks.map((t: { taskId: string }) => t.taskId)).toEqual(["t1", "t2"]);
        });

        it("returns empty list when no tasks match the status filter", async () => {
            const completed = makeMockTask({
                taskId: "t1",
                status: "completed",
                completedAt: "2025-01-01T01:00:00.000Z"
            });
            const tm = makeMockTaskManager({
                listTasks: vi.fn().mockReturnValue([completed])
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).get("/tasks?status=running").expect(200);
            expect(res.body.tasks).toEqual([]);
        });

        it("returns 400 for invalid status value", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            const res = await request(app).get("/tasks?status=invalid").expect(400);
            expect(res.body.error).toBe("Invalid status value");
        });

        it("includes pullRequestNumber in task list items", async () => {
            const task = makeMockTask({
                status: "completed",
                completedAt: "2025-01-01T01:00:00.000Z",
                pullRequestNumber: 42
            });
            const tm = makeMockTaskManager({
                listTasks: vi.fn().mockReturnValue([task])
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).get("/tasks").expect(200);
            expect(res.body.tasks[0].pullRequestNumber).toBe(42);
        });

        it("returns null pullRequestNumber for tasks without one", async () => {
            const task = makeMockTask({
                status: "completed",
                completedAt: "2025-01-01T01:00:00.000Z"
            });
            const tm = makeMockTaskManager({
                listTasks: vi.fn().mockReturnValue([task])
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).get("/tasks").expect(200);
            expect(res.body.tasks[0].pullRequestNumber).toBeNull();
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

        it("returns pullRequestNumber when present", async () => {
            const task = makeMockTask({
                status: "completed",
                completedAt: "2025-01-01T00:05:00.000Z",
                pullRequestNumber: 42
            });
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(task)
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).get("/task/abc123").expect(200);
            expect(res.body.pullRequestNumber).toBe(42);
        });

        it("returns null pullRequestNumber when not present", async () => {
            const task = makeMockTask({
                status: "completed",
                completedAt: "2025-01-01T00:05:00.000Z"
            });
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(task)
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).get("/task/abc123").expect(200);
            expect(res.body.pullRequestNumber).toBeNull();
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

    describe("POST /task/:taskId/retry", () => {
        it("returns task info on successful retry", async () => {
            const task = makeMockTask({ status: "failed", error: "previous error" });
            const retried = makeMockTask({ status: "running", error: undefined });
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(task),
                retryTask: vi.fn().mockResolvedValue(retried)
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).post("/task/abc123/retry").expect(200);
            expect(res.body.taskId).toBe("abc123");
            expect(res.body.branch).toBe("impl/test-branch-abc123");
            expect(res.body.status).toBe("running");
        });

        it("returns queued status when at capacity", async () => {
            const task = makeMockTask({ status: "completed" });
            const retried = makeMockTask({ status: "queued" });
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(task),
                retryTask: vi.fn().mockResolvedValue(retried)
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).post("/task/abc123/retry").expect(200);
            expect(res.body.status).toBe("queued");
        });

        it("returns 404 when task not found", async () => {
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(undefined)
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).post("/task/nonexistent/retry").expect(404);
            expect(res.body.error).toBe("Task not found");
        });

        it("returns 409 when task is currently active", async () => {
            const task = makeMockTask({ status: "running" });
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(task),
                retryTask: vi.fn().mockRejectedValue(new TaskActiveError("running"))
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).post("/task/abc123/retry").expect(409);
            expect(res.body.error).toContain("running");
        });

        it("returns 500 on unexpected error", async () => {
            const task = makeMockTask({ status: "failed" });
            const tm = makeMockTaskManager({
                getTask: vi.fn().mockReturnValue(task),
                retryTask: vi.fn().mockRejectedValue(new Error("unexpected"))
            });
            const app = createServer(tm, makeConfig());

            const res = await request(app).post("/task/abc123/retry").expect(500);
            expect(res.body.error).toBe("unexpected");
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

        it("does not expose project data through /dashboard/events when project auth is configured", async () => {
            // /dashboard/events with no adminPassword returns 404, not project data
            const app = createServer(
                makeMockTaskManager(),
                makeConfig({ apiKey: "test-secret" })
            );
            await request(app).get("/dashboard/events").expect(404);
        });

        it("allows /dashboard without API key even when auth is configured", async () => {
            const app = createServer(
                makeMockTaskManager(),
                makeConfig({ apiKey: "test-secret" })
            );
            // dashboard returns 404 when no adminPassword configured (not 401)
            const res = await request(app).get("/dashboard");
            expect(res.status).not.toBe(401);
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

    describe("GET /dashboard", () => {
        it("returns 404 when adminPassword is not configured", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            await request(app).get("/dashboard").expect(404);
        });

        it("returns login form when not authenticated", async () => {
            const config: Config = {
                server: { workspaceDir: "/tmp/test", adminPassword: "secret" },
                projects: {
                    [PROJECT_ID]: {
                        repositories: [{ name: "repo", url: "https://example.com/repo.git", defaultBranch: "main" }],
                        claudeCode: { command: "claude" }
                    }
                }
            };
            const res = await request(createServer(makeMockTaskManager(), config))
                .get("/dashboard")
                .expect(200);
            expect(res.text).toContain("<form");
            expect(res.text).toContain("password");
        });

        it("returns dashboard HTML when authenticated via cookie", async () => {
            const config: Config = {
                server: { workspaceDir: "/tmp/test", adminPassword: "secret" },
                projects: {
                    [PROJECT_ID]: {
                        repositories: [{ name: "repo", url: "https://example.com/repo.git", defaultBranch: "main" }],
                        claudeCode: { command: "claude" }
                    }
                }
            };
            // First login to get cookie
            const loginRes = await request(createServer(makeMockTaskManager(), config))
                .post("/dashboard")
                .type("form")
                .send({ password: "secret" })
                .expect(302);
            const setCookie = loginRes.headers["set-cookie"] as string[] | string;
            const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
            const cookieValue = cookieHeader?.split(";")[0] ?? "";

            const res = await request(createServer(makeMockTaskManager(), config))
                .get("/dashboard")
                .set("Cookie", cookieValue)
                .expect(200);
            expect(res.text).toContain("EventSource");
        });
    });

    describe("POST /dashboard", () => {
        it("returns 404 when adminPassword is not configured", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            await request(app)
                .post("/dashboard")
                .type("form")
                .send({ password: "anything" })
                .expect(404);
        });

        it("sets auth cookie and redirects on correct password", async () => {
            const config: Config = {
                server: { workspaceDir: "/tmp/test", adminPassword: "secret" },
                projects: {
                    [PROJECT_ID]: {
                        repositories: [{ name: "repo", url: "https://example.com/repo.git", defaultBranch: "main" }],
                        claudeCode: { command: "claude" }
                    }
                }
            };
            const res = await request(createServer(makeMockTaskManager(), config))
                .post("/dashboard")
                .type("form")
                .send({ password: "secret" })
                .expect(302);
            expect(res.headers.location).toBe("/dashboard");
            expect(res.headers["set-cookie"]).toBeDefined();
            expect((res.headers["set-cookie"] as unknown as string[])[0]).toContain("impl_dash=");
        });

        it("returns login form with error on wrong password", async () => {
            const config: Config = {
                server: { workspaceDir: "/tmp/test", adminPassword: "secret" },
                projects: {
                    [PROJECT_ID]: {
                        repositories: [{ name: "repo", url: "https://example.com/repo.git", defaultBranch: "main" }],
                        claudeCode: { command: "claude" }
                    }
                }
            };
            const res = await request(createServer(makeMockTaskManager(), config))
                .post("/dashboard")
                .type("form")
                .send({ password: "wrong" })
                .expect(200);
            expect(res.text).toContain("Incorrect password");
            expect(res.headers["set-cookie"]).toBeUndefined();
        });
    });

    describe("GET /dashboard/events", () => {
        it("returns 404 when adminPassword is not configured", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            await request(app).get("/dashboard/events").expect(404);
        });

        it("returns 401 when not authenticated", async () => {
            const config: Config = {
                server: { workspaceDir: "/tmp/test", adminPassword: "secret" },
                projects: {
                    [PROJECT_ID]: {
                        repositories: [{ name: "repo", url: "https://example.com/repo.git", defaultBranch: "main" }],
                        claudeCode: { command: "claude" }
                    }
                }
            };
            await request(createServer(makeMockTaskManager(), config))
                .get("/dashboard/events")
                .expect(401);
        });
    });

    describe("GET /dashboard/logout", () => {
        it("clears cookie and redirects to /dashboard", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            const res = await request(app).get("/dashboard/logout").expect(302);
            expect(res.headers.location).toBe("/dashboard");
            const cookie = (res.headers["set-cookie"] as unknown as string[])?.[0] ?? "";
            expect(cookie).toContain("Max-Age=0");
        });
    });

    describe("GET /dashboard/api/task/:taskId", () => {
        it("returns 404 when adminPassword is not configured", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            await request(app).get("/dashboard/api/task/abc123").expect(404);
        });

        it("returns 401 when not authenticated", async () => {
            const app = createServer(makeMockTaskManager(), makeConfigWithAdmin());
            await request(app).get("/dashboard/api/task/abc123").expect(401);
        });

        it("returns 404 for unknown task", async () => {
            const tm = makeMockTaskManager({ listAllTasks: vi.fn().mockReturnValue([]) });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);
            await request(app).get("/dashboard/api/task/nonexistent").set("Cookie", cookie).expect(404);
        });

        it("returns full task details for a completed task", async () => {
            const task = makeMockTask({
                status: "completed",
                completedAt: "2025-01-01T00:05:00.000Z",
                pullRequests: [{ repo: "my-repo", url: "https://github.com/org/repo/pull/42" }]
            });
            const tm = makeMockTaskManager({ listAllTasks: vi.fn().mockReturnValue([task]) });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .get("/dashboard/api/task/abc123")
                .set("Cookie", cookie)
                .expect(200);

            expect(res.body.taskId).toBe("abc123");
            expect(res.body.prompt).toBe("Add a button");
            expect(res.body.status).toBe("completed");
            expect(res.body.projectId).toBe(PROJECT_ID);
            expect(res.body.branch).toBe("impl/test-branch-abc123");
            expect(res.body.durationSeconds).toBe(300);
            expect(res.body.pullRequests).toEqual([
                { repo: "my-repo", url: "https://github.com/org/repo/pull/42" }
            ]);
        });

        it("returns null output for a running task", async () => {
            const task = makeMockTask({ status: "running" });
            const tm = makeMockTaskManager({ listAllTasks: vi.fn().mockReturnValue([task]) });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .get("/dashboard/api/task/abc123")
                .set("Cookie", cookie)
                .expect(200);

            expect(res.body.output).toBeNull();
        });

        it("returns error field when task has error", async () => {
            const task = makeMockTask({ status: "failed", error: "something went wrong" });
            const tm = makeMockTaskManager({ listAllTasks: vi.fn().mockReturnValue([task]) });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .get("/dashboard/api/task/abc123")
                .set("Cookie", cookie)
                .expect(200);

            expect(res.body.error).toBe("something went wrong");
        });
    });

    describe("POST /dashboard/api/task", () => {
        it("returns 404 when adminPassword is not configured", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            await request(app).post("/dashboard/api/task").send({}).expect(404);
        });

        it("returns 401 when not authenticated", async () => {
            const app = createServer(makeMockTaskManager(), makeConfigWithAdmin());
            await request(app).post("/dashboard/api/task").send({}).expect(401);
        });

        it("returns 400 for invalid project ID", async () => {
            const tm = makeMockTaskManager();
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .post("/dashboard/api/task")
                .set("Cookie", cookie)
                .send({ projectId: "nonexistent-project", prompt: "test" })
                .expect(400);

            expect(res.body.error).toMatch(/[Ii]nvalid/);
        });

        it("returns 400 for missing prompt", async () => {
            const tm = makeMockTaskManager();
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .post("/dashboard/api/task")
                .set("Cookie", cookie)
                .send({ projectId: PROJECT_ID })
                .expect(400);

            expect(res.body.error).toMatch(/[Pp]rompt/);
        });

        it("returns 400 for empty prompt", async () => {
            const tm = makeMockTaskManager();
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .post("/dashboard/api/task")
                .set("Cookie", cookie)
                .send({ projectId: PROJECT_ID, prompt: "   " })
                .expect(400);

            expect(res.body.error).toMatch(/[Pp]rompt/);
        });

        it("creates a task and returns taskId", async () => {
            const task = makeMockTask({ status: "queued", branch: null });
            const startTask = vi.fn().mockResolvedValue(task);
            const tm = makeMockTaskManager({ startTask });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .post("/dashboard/api/task")
                .set("Cookie", cookie)
                .send({ projectId: PROJECT_ID, prompt: "Add a button" })
                .expect(200);

            expect(res.body.taskId).toBe("abc123");
            expect(res.body.status).toBe("queued");
            expect(startTask).toHaveBeenCalledWith(PROJECT_ID, { prompt: "Add a button", pullRequestNumber: undefined });
        });

        it("passes pullRequestNumber when provided as integer", async () => {
            const task = makeMockTask({ status: "queued", branch: null, pullRequestNumber: 42 });
            const startTask = vi.fn().mockResolvedValue(task);
            const tm = makeMockTaskManager({ startTask });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            await request(app)
                .post("/dashboard/api/task")
                .set("Cookie", cookie)
                .send({ projectId: PROJECT_ID, prompt: "Fix bug", pullRequestNumber: 42 })
                .expect(200);

            expect(startTask).toHaveBeenCalledWith(PROJECT_ID, {
                prompt: "Fix bug",
                pullRequestNumber: 42
            });
        });

        it("returns 429 when token usage limit is exceeded", async () => {
            const tm = makeMockTaskManager({
                startTask: vi.fn().mockRejectedValue(new UsageLimitError(600_000, 500_000))
            });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .post("/dashboard/api/task")
                .set("Cookie", cookie)
                .send({ projectId: PROJECT_ID, prompt: "Do something" })
                .expect(429);

            expect(res.body.error).toContain("Token usage limit exceeded");
        });
    });

    describe("GET /dashboard/api/data", () => {
        it("returns 404 when adminPassword is not configured", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            await request(app).get("/dashboard/api/data").expect(404);
        });

        it("returns 401 when not authenticated", async () => {
            const app = createServer(makeMockTaskManager(), makeConfigWithAdmin());
            await request(app).get("/dashboard/api/data").expect(401);
        });

        it("returns tasks, stats, and projects when authenticated", async () => {
            const task = makeMockTask({ status: "running" });
            const tm = makeMockTaskManager({ listAllTasks: vi.fn().mockReturnValue([task]) });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .get("/dashboard/api/data")
                .set("Cookie", cookie)
                .expect(200);

            expect(res.body.tasks).toHaveLength(1);
            expect(res.body.tasks[0].taskId).toBe("abc123");
            expect(res.body.tasks[0].status).toBe("running");
            expect(res.body.stats.running).toBe(1);
            expect(res.body.stats.queued).toBe(0);
            expect(res.body.stats.completed).toBe(0);
            expect(res.body.projects).toBeDefined();
            expect(res.body.projects[PROJECT_ID]).toBeDefined();
            expect(res.body.projects[PROJECT_ID].running).toBe(1);
        });

        it("returns empty tasks and zero stats when no tasks exist", async () => {
            const tm = makeMockTaskManager({ listAllTasks: vi.fn().mockReturnValue([]) });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .get("/dashboard/api/data")
                .set("Cookie", cookie)
                .expect(200);

            expect(res.body.tasks).toEqual([]);
            expect(res.body.stats.running).toBe(0);
            expect(res.body.stats.total).toBe(0);
        });

        it("includes durationSeconds in task list items", async () => {
            const task = makeMockTask({
                status: "completed",
                completedAt: "2025-01-01T01:00:00.000Z"
            });
            const tm = makeMockTaskManager({ listAllTasks: vi.fn().mockReturnValue([task]) });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .get("/dashboard/api/data")
                .set("Cookie", cookie)
                .expect(200);

            expect(typeof res.body.tasks[0].durationSeconds).toBe("number");
        });

        it("counts each status correctly in stats", async () => {
            const tasks = [
                makeMockTask({ taskId: "t1", status: "running" }),
                makeMockTask({ taskId: "t2", status: "queued" }),
                makeMockTask({ taskId: "t3", status: "queued" }),
                makeMockTask({ taskId: "t4", status: "completed", completedAt: "2025-01-01T01:00:00.000Z" }),
                makeMockTask({ taskId: "t5", status: "failed" })
            ];
            const tm = makeMockTaskManager({ listAllTasks: vi.fn().mockReturnValue(tasks) });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .get("/dashboard/api/data")
                .set("Cookie", cookie)
                .expect(200);

            expect(res.body.stats.running).toBe(1);
            expect(res.body.stats.queued).toBe(2);
            expect(res.body.stats.completed).toBe(1);
            expect(res.body.stats.failed).toBe(1);
            expect(res.body.stats.total).toBe(5);
        });
    });

    describe("POST /dashboard/api/task/:taskId/retry", () => {
        it("returns 404 when adminPassword is not configured", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            await request(app).post("/dashboard/api/task/abc123/retry").expect(404);
        });

        it("returns 401 when not authenticated", async () => {
            const app = createServer(makeMockTaskManager(), makeConfigWithAdmin());
            await request(app).post("/dashboard/api/task/abc123/retry").expect(401);
        });

        it("returns 404 for unknown task", async () => {
            const tm = makeMockTaskManager({ listAllTasks: vi.fn().mockReturnValue([]) });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            await request(app)
                .post("/dashboard/api/task/nonexistent/retry")
                .set("Cookie", cookie)
                .expect(404);
        });

        it("retries a failed task and returns the new task info", async () => {
            const task = makeMockTask({ status: "failed" });
            const retried = makeMockTask({ status: "queued" });
            const tm = makeMockTaskManager({
                listAllTasks: vi.fn().mockReturnValue([task]),
                retryTask: vi.fn().mockResolvedValue(retried)
            });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .post("/dashboard/api/task/abc123/retry")
                .set("Cookie", cookie)
                .expect(200);

            expect(res.body.taskId).toBe("abc123");
            expect(res.body.status).toBe("queued");
        });

        it("returns 409 when task is currently active", async () => {
            const task = makeMockTask({ status: "running" });
            const tm = makeMockTaskManager({
                listAllTasks: vi.fn().mockReturnValue([task]),
                retryTask: vi.fn().mockRejectedValue(new TaskActiveError("running"))
            });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .post("/dashboard/api/task/abc123/retry")
                .set("Cookie", cookie)
                .expect(409);

            expect(res.body.error).toContain("running");
        });

        it("returns 500 on unexpected error", async () => {
            const task = makeMockTask({ status: "failed" });
            const tm = makeMockTaskManager({
                listAllTasks: vi.fn().mockReturnValue([task]),
                retryTask: vi.fn().mockRejectedValue(new Error("unexpected"))
            });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .post("/dashboard/api/task/abc123/retry")
                .set("Cookie", cookie)
                .expect(500);

            expect(res.body.error).toBe("unexpected");
        });
    });

    describe("POST /dashboard/api/tasks/retry-failed", () => {
        it("returns 404 when adminPassword is not configured", async () => {
            const app = createServer(makeMockTaskManager(), makeConfig());
            await request(app).post("/dashboard/api/tasks/retry-failed").expect(404);
        });

        it("returns 401 when not authenticated", async () => {
            const app = createServer(makeMockTaskManager(), makeConfigWithAdmin());
            await request(app).post("/dashboard/api/tasks/retry-failed").expect(401);
        });

        it("returns retried=0 when there are no failed tasks", async () => {
            const tasks = [
                makeMockTask({ taskId: "t1", status: "running" }),
                makeMockTask({ taskId: "t2", status: "completed" })
            ];
            const tm = makeMockTaskManager({
                listAllTasks: vi.fn().mockReturnValue(tasks),
                retryTask: vi.fn()
            });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .post("/dashboard/api/tasks/retry-failed")
                .set("Cookie", cookie)
                .expect(200);

            expect(res.body.retried).toBe(0);
            expect(res.body.errors).toEqual([]);
            expect(tm.retryTask).not.toHaveBeenCalled();
        });

        it("retries all failed tasks and returns count", async () => {
            const tasks = [
                makeMockTask({ taskId: "t1", status: "failed" }),
                makeMockTask({ taskId: "t2", status: "failed" }),
                makeMockTask({ taskId: "t3", status: "completed" })
            ];
            const tm = makeMockTaskManager({
                listAllTasks: vi.fn().mockReturnValue(tasks),
                retryTask: vi.fn().mockResolvedValue(makeMockTask({ status: "queued" }))
            });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .post("/dashboard/api/tasks/retry-failed")
                .set("Cookie", cookie)
                .expect(200);

            expect(res.body.retried).toBe(2);
            expect(res.body.errors).toEqual([]);
            expect(tm.retryTask).toHaveBeenCalledTimes(2);
        });

        it("reports errors for tasks that could not be retried", async () => {
            const tasks = [
                makeMockTask({ taskId: "t1", status: "failed" }),
                makeMockTask({ taskId: "t2", status: "failed" })
            ];
            const tm = makeMockTaskManager({
                listAllTasks: vi.fn().mockReturnValue(tasks),
                retryTask: vi
                    .fn()
                    .mockResolvedValueOnce(makeMockTask({ status: "queued" }))
                    .mockRejectedValueOnce(new Error("retry failed"))
            });
            const app = createServer(tm, makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);

            const res = await request(app)
                .post("/dashboard/api/tasks/retry-failed")
                .set("Cookie", cookie)
                .expect(200);

            expect(res.body.retried).toBe(1);
            expect(res.body.errors).toEqual(["retry failed"]);
        });
    });

    describe("theme toggle", () => {
        it("login page includes CSS custom properties for dark mode", async () => {
            const app = createServer(makeMockTaskManager(), makeConfigWithAdmin());
            const res = await request(app).get("/dashboard").expect(200);
            expect(res.text).toContain("--bg:");
            expect(res.text).toContain("[data-theme=light]");
        });

        it("login page includes theme toggle button", async () => {
            const app = createServer(makeMockTaskManager(), makeConfigWithAdmin());
            const res = await request(app).get("/dashboard").expect(200);
            expect(res.text).toContain("theme-toggle");
            expect(res.text).toContain("toggleTheme");
        });

        it("login page includes FOUC prevention script", async () => {
            const app = createServer(makeMockTaskManager(), makeConfigWithAdmin());
            const res = await request(app).get("/dashboard").expect(200);
            expect(res.text).toContain("impl-theme");
            expect(res.text).toContain("data-theme");
        });

        it("dashboard includes CSS custom properties for both themes", async () => {
            const app = createServer(makeMockTaskManager(), makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);
            const res = await request(app).get("/dashboard").set("Cookie", cookie).expect(200);
            expect(res.text).toContain("--bg:");
            expect(res.text).toContain("[data-theme=light]");
            expect(res.text).toContain("--b-run-bg");
        });

        it("dashboard includes theme toggle button in header", async () => {
            const app = createServer(makeMockTaskManager(), makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);
            const res = await request(app).get("/dashboard").set("Cookie", cookie).expect(200);
            expect(res.text).toContain("theme-toggle");
            expect(res.text).toContain("toggleTheme");
        });

        it("dashboard includes FOUC prevention script", async () => {
            const app = createServer(makeMockTaskManager(), makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);
            const res = await request(app).get("/dashboard").set("Cookie", cookie).expect(200);
            expect(res.text).toContain("impl-theme");
            expect(res.text).toContain("localStorage");
        });

        it("dashboard uses CSS variables instead of hardcoded dark colors", async () => {
            const app = createServer(makeMockTaskManager(), makeConfigWithAdmin());
            const cookie = await getAdminCookie(app);
            const res = await request(app).get("/dashboard").set("Cookie", cookie).expect(200);
            expect(res.text).toContain("var(--bg)");
            expect(res.text).toContain("var(--bg-card)");
            expect(res.text).toContain("var(--text)");
        });
    });
});
