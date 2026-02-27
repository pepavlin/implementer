import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { registerDashboardRoutes, buildDashboardData, dashboardToken } from "../src/dashboard.js";
import type { Task, TaskId, ProjectId, ChainId } from "../src/types.js";
import type { Config } from "../src/config/config.js";
import type { TaskManager } from "../src/task-manager/task-manager.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ADMIN_PASSWORD = "test-password";
const AUTH_TOKEN = dashboardToken(ADMIN_PASSWORD);
const AUTH_COOKIE = `impl_dash=${AUTH_TOKEN}`;

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        taskId: "abc12345" as TaskId,
        projectId: "my-project" as ProjectId,
        branch: "impl/abc12345",
        prompt: "Do something",
        title: "Test task",
        status: "completed",
        startedAt: new Date("2024-01-01T10:00:00Z").toISOString(),
        completedAt: new Date("2024-01-01T10:05:00Z").toISOString(),
        output: "",
        chainId: "abc12345" as ChainId,
        attempt: 1,
        ...overrides
    };
}

function makeConfig(maxAttempts?: number): Partial<Config> {
    return {
        server: { workspaceDir: "/tmp/test", adminPassword: ADMIN_PASSWORD },
        projects: {
            "my-project": {
                repositories: [],
                claudeCode: { command: "claude", timeoutSeconds: 3600 },
                ...(maxAttempts !== undefined
                    ? { errorRetry: { maxAttempts, delaySeconds: 60 } }
                    : {})
            }
        } as unknown as Config["projects"]
    };
}

function makeTaskManager(tasks: Task[]): Partial<TaskManager> {
    return {
        listAllTasks: vi.fn(() => tasks)
    };
}

function createApp(tasks: Task[], configOverride?: Partial<Config>): express.Express {
    const app = express();
    app.use(express.json());
    const tm = makeTaskManager(tasks) as unknown as TaskManager;
    const cfg = (configOverride ?? makeConfig()) as unknown as Config;
    registerDashboardRoutes(app, tm, cfg);
    return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /dashboard/api/task/:taskId", () => {
    it("returns attempt and null maxAttempts when no errorRetry configured", async () => {
        const task = makeTask({ attempt: 2 });
        const app = createApp([task], makeConfig() as unknown as Config);

        const res = await request(app)
            .get("/dashboard/api/task/abc12345")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.body.attempt).toBe(2);
        expect(res.body.maxAttempts).toBeNull();
        expect(res.body.nextRetryAt).toBeNull();
    });

    it("returns attempt and maxAttempts when errorRetry is configured", async () => {
        const task = makeTask({ attempt: 3 });
        const app = createApp([task], makeConfig(5) as unknown as Config);

        const res = await request(app)
            .get("/dashboard/api/task/abc12345")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.body.attempt).toBe(3);
        expect(res.body.maxAttempts).toBe(5);
    });

    it("returns nextRetryAt for retrying tasks", async () => {
        const nextRetryAt = new Date(Date.now() + 60_000).toISOString();
        const task = makeTask({
            status: "retrying",
            completedAt: null,
            attempt: 2,
            nextRetryAt
        });
        const app = createApp([task], makeConfig(5) as unknown as Config);

        const res = await request(app)
            .get("/dashboard/api/task/abc12345")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("retrying");
        expect(res.body.nextRetryAt).toBe(nextRetryAt);
        expect(res.body.attempt).toBe(2);
        expect(res.body.maxAttempts).toBe(5);
    });

    it("returns null nextRetryAt for non-retrying tasks", async () => {
        const task = makeTask({ status: "failed", attempt: 3 });
        const app = createApp([task], makeConfig(3) as unknown as Config);

        const res = await request(app)
            .get("/dashboard/api/task/abc12345")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.body.nextRetryAt).toBeNull();
    });

    it("returns 404 when task not found", async () => {
        const app = createApp([], makeConfig() as unknown as Config);

        const res = await request(app)
            .get("/dashboard/api/task/nonexistent")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
        const task = makeTask();
        const app = createApp([task], makeConfig() as unknown as Config);

        const res = await request(app).get("/dashboard/api/task/abc12345");

        expect(res.status).toBe(401);
    });
});

describe("buildDashboardData", () => {
    it("includes task stats by status", () => {
        const tasks: Task[] = [
            makeTask({ status: "running" }),
            makeTask({ taskId: "bbb22222" as TaskId, status: "retrying", attempt: 2 }),
            makeTask({ taskId: "ccc33333" as TaskId, status: "failed", attempt: 3 })
        ];
        const tm = makeTaskManager(tasks) as unknown as TaskManager;
        const cfg = makeConfig(5) as unknown as Config;

        const data = buildDashboardData(tm, cfg);

        expect(data.stats.running).toBe(1);
        expect(data.stats.retrying).toBe(1);
        expect(data.stats.failed).toBe(1);
    });

    it("builds project stats", () => {
        const tasks: Task[] = [
            makeTask({ status: "completed" }),
            makeTask({ taskId: "bbb22222" as TaskId, status: "running" })
        ];
        const tm = makeTaskManager(tasks) as unknown as TaskManager;
        const cfg = makeConfig() as unknown as Config;

        const data = buildDashboardData(tm, cfg);

        expect(data.projects["my-project"]).toBeDefined();
        expect(data.projects["my-project"].completed).toBe(1);
        expect(data.projects["my-project"].running).toBe(1);
    });
});
