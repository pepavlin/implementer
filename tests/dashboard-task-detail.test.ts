import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { registerDashboardRoutes, buildDashboardData, dashboardToken } from "../src/dashboard.js";
import type { Task, TaskId, ProjectId, ChainId } from "../src/types.js";
import type { Config } from "../src/config/config.js";
import type { TaskManager } from "../src/task-manager/task-manager.js";
import { TaskActiveError } from "../src/task-manager/task-manager.js";

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

function makeTaskManager(tasks: Task[], overrides: Partial<TaskManager> = {}): Partial<TaskManager> {
    return {
        listAllTasks: vi.fn(() => tasks),
        ...overrides,
    };
}

function createApp(tasks: Task[], configOverride?: Partial<Config>, tmOverrides?: Partial<TaskManager>): express.Express {
    const app = express();
    app.use(express.json());
    const tm = makeTaskManager(tasks, tmOverrides) as unknown as TaskManager;
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

    it("places queued tasks before non-queued tasks regardless of startedAt order", () => {
        // allTasks arrives already sorted by startedAt desc: completed (newest) first, then queued (oldest)
        const tasks: Task[] = [
            makeTask({
                taskId: "completed1" as TaskId,
                status: "completed",
                startedAt: new Date("2024-01-01T12:00:00Z").toISOString()
            }),
            makeTask({
                taskId: "running1" as TaskId,
                status: "running",
                startedAt: new Date("2024-01-01T11:00:00Z").toISOString()
            }),
            makeTask({
                taskId: "queued1" as TaskId,
                status: "queued",
                startedAt: new Date("2024-01-01T10:00:00Z").toISOString()
            })
        ];
        const tm = makeTaskManager(tasks) as unknown as TaskManager;
        const cfg = makeConfig() as unknown as Config;

        const data = buildDashboardData(tm, cfg);
        const taskList = data.tasks as Array<{ taskId: string; status: string }>;

        // queued task must come first even though it has the oldest startedAt
        expect(taskList[0].taskId).toBe("queued1");
        expect(taskList[0].status).toBe("queued");
        // non-queued tasks follow, newest first
        expect(taskList[1].taskId).toBe("completed1");
        expect(taskList[2].taskId).toBe("running1");
    });

    it("places starting tasks at top together with queued tasks", () => {
        const tasks: Task[] = [
            makeTask({
                taskId: "completed1" as TaskId,
                status: "completed",
                startedAt: new Date("2024-01-01T13:00:00Z").toISOString()
            }),
            makeTask({
                taskId: "starting1" as TaskId,
                status: "starting",
                startedAt: new Date("2024-01-01T11:00:00Z").toISOString()
            }),
            makeTask({
                taskId: "queued1" as TaskId,
                status: "queued",
                startedAt: new Date("2024-01-01T10:00:00Z").toISOString()
            })
        ];
        const tm = makeTaskManager(tasks) as unknown as TaskManager;
        const cfg = makeConfig() as unknown as Config;

        const data = buildDashboardData(tm, cfg);
        const taskList = data.tasks as Array<{ taskId: string; status: string }>;

        // starting and queued tasks must both be at the top
        expect(["starting", "queued"]).toContain(taskList[0].status);
        expect(["starting", "queued"]).toContain(taskList[1].status);
        // completed is last
        expect(taskList[2].taskId).toBe("completed1");
    });

    it("sorts multiple queued tasks newest first within the queue group", () => {
        const tasks: Task[] = [
            makeTask({
                taskId: "queued-old" as TaskId,
                status: "queued",
                startedAt: new Date("2024-01-01T09:00:00Z").toISOString()
            }),
            makeTask({
                taskId: "queued-new" as TaskId,
                status: "queued",
                startedAt: new Date("2024-01-01T11:00:00Z").toISOString()
            }),
            makeTask({
                taskId: "completed1" as TaskId,
                status: "completed",
                startedAt: new Date("2024-01-01T10:00:00Z").toISOString()
            })
        ];
        const tm = makeTaskManager(tasks) as unknown as TaskManager;
        const cfg = makeConfig() as unknown as Config;

        const data = buildDashboardData(tm, cfg);
        const taskList = data.tasks as Array<{ taskId: string; status: string }>;

        // newest queued task should be at the very top
        expect(taskList[0].taskId).toBe("queued-new");
        expect(taskList[1].taskId).toBe("queued-old");
        expect(taskList[2].taskId).toBe("completed1");
    });
});

describe("dashboard HTML - completed vs cancelled visual distinction", () => {
    it("renders dashboard HTML with distinct CSS variables for completed and cancelled", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        const html = res.text;

        // completed should use emerald green (--b-done-bg/fg)
        expect(html).toContain("--b-done-bg:#0a2e1e");
        expect(html).toContain("--b-done-fg:#34d399");

        // cancelled should use a different (muted) style
        expect(html).toContain("--b-can-bg:#1e2130");
        expect(html).toContain("--b-can-fg:#475569");

        // completed and cancelled variables must be different
        expect(html).not.toContain("--b-done-bg:#1a2535");
        expect(html).not.toContain("--b-done-fg:#64748b");
    });

    it("renders dashboard HTML with separate CSS classes for completed and cancelled badges", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        const html = res.text;

        // Both classes must exist and reference different variables
        expect(html).toContain(".b-completed{background:var(--b-done-bg);color:var(--b-done-fg)}");
        expect(html).toContain(".b-cancelled{background:var(--b-can-bg);color:var(--b-can-fg)}");
    });

    it("renders completed badge with checkmark icon", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        const html = res.text;

        // completed badge should contain checkmark entity
        expect(html).toContain("&#10003; Completed");
        // cancelled badge should contain × entity
        expect(html).toContain("&#215; Cancelled");
    });

    it("renders table rows with distinct left-border CSS for completed and cancelled", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        const html = res.text;

        // completed row gets emerald left border
        expect(html).toContain(".tr-completed td:first-child{border-left:3px solid #34d39960}");
        // cancelled row gets muted left border
        expect(html).toContain(".tr-cancelled td:first-child{border-left:3px solid #47556940}");
    });

    it("light mode has distinct colours for completed and cancelled", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        const html = res.text;

        // light mode completed: light emerald
        expect(html).toContain("--b-done-bg:#d1fae5");
        expect(html).toContain("--b-done-fg:#059669");

        // light mode cancelled: light gray (distinct from completed)
        expect(html).toContain("--b-can-bg:#f1f5f9");
        expect(html).toContain("--b-can-fg:#64748b");
    });
});

describe("buildDashboardData - completedAt field", () => {
    it("includes completedAt in task list data", () => {
        const completedAt = new Date("2024-01-01T10:05:00Z").toISOString();
        const tasks: Task[] = [makeTask({ status: "completed", completedAt })];
        const tm = makeTaskManager(tasks) as unknown as TaskManager;
        const cfg = makeConfig() as unknown as Config;

        const data = buildDashboardData(tm, cfg);

        expect(data.tasks).toHaveLength(1);
        expect((data.tasks[0] as Record<string, unknown>).completedAt).toBe(completedAt);
    });

    it("includes null completedAt for non-completed tasks", () => {
        const tasks: Task[] = [makeTask({ status: "running", completedAt: null })];
        const tm = makeTaskManager(tasks) as unknown as TaskManager;
        const cfg = makeConfig() as unknown as Config;

        const data = buildDashboardData(tm, cfg);

        expect((data.tasks[0] as Record<string, unknown>).completedAt).toBeNull();
    });
});

describe("dashboard HTML - completed badge recency styling", () => {
    it("includes b-completed-old CSS class for muted old completed badges", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain(".b-completed-old{");
    });

    it("includes tr-completed-old CSS class for old completed rows", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain(".tr-completed-old td:first-child{border-left:3px solid #47556930}");
    });

    it("includes isRecentCompleted helper in JS with 20-minute threshold", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        // 20 minutes = 1200000 ms
        expect(res.text).toContain("isRecentCompleted");
        expect(res.text).toContain("1200000");
    });
});

describe("POST /dashboard/api/task/:taskId/retry-now", () => {
    it("returns 401 without authentication", async () => {
        const task = makeTask({ status: "retrying", completedAt: null });
        const app = createApp([task]);

        const res = await request(app)
            .post("/dashboard/api/task/abc12345/retry-now")
            .send({});

        expect(res.status).toBe(401);
    });

    it("returns 404 when task not found", async () => {
        const app = createApp([]);

        const res = await request(app)
            .post("/dashboard/api/task/nonexistent/retry-now")
            .set("Cookie", AUTH_COOKIE)
            .send({});

        expect(res.status).toBe(404);
    });

    it("returns 409 when task is not in retrying status", async () => {
        const task = makeTask({ status: "failed" });
        const retryTaskNow = vi.fn().mockRejectedValue(new TaskActiveError("failed"));
        const app = createApp([task], makeConfig(), { retryTaskNow } as any);

        const res = await request(app)
            .post("/dashboard/api/task/abc12345/retry-now")
            .set("Cookie", AUTH_COOKIE)
            .send({});

        expect(res.status).toBe(409);
    });

    it("returns queued status after immediate retry of retrying task", async () => {
        const nextRetryAt = new Date(Date.now() + 60_000).toISOString();
        const task = makeTask({ status: "retrying", completedAt: null, nextRetryAt });
        const retryTaskNow = vi.fn().mockResolvedValue({ ...task, status: "queued", nextRetryAt: undefined });
        const app = createApp([task], makeConfig(), { retryTaskNow } as any);

        const res = await request(app)
            .post("/dashboard/api/task/abc12345/retry-now")
            .set("Cookie", AUTH_COOKIE)
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("queued");
        expect(retryTaskNow).toHaveBeenCalledWith("my-project", "abc12345");
    });

    it("renders Retry Now button only for retrying tasks", async () => {
        const task = makeTask({ status: "retrying", completedAt: null });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain("task-retry-now");
        expect(res.text).toContain("retryNow()");
        expect(res.text).toContain("retry-now");
    });
});
