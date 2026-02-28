import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { registerDashboardRoutes, buildDashboardData, dashboardToken } from "../src/dashboard.js";
import type { TaskId, ProjectId, ChainId } from "../src/types.js";
import type { Config } from "../src/config/config.js";
import type { TaskManager } from "../src/task-manager/task-manager.js";
import { TaskActiveError } from "../src/task-manager/task-manager.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ADMIN_PASSWORD = "test-password";
const AUTH_TOKEN = dashboardToken(ADMIN_PASSWORD);
const AUTH_COOKIE = `impl_dash=${AUTH_TOKEN}`;

function makeTask(overrides: Partial<any> = {}): any {
    const errorRetry = overrides.errorRetry;
    delete overrides.errorRetry;

    const data = {
        taskId: overrides.taskId ?? "abc12345",
        projectId: overrides.projectId ?? "my-project",
        prompt: overrides.prompt ?? "Do something",
        status: overrides.status ?? "completed",
        startedAt: overrides.startedAt ?? new Date("2024-01-01T10:00:00Z").toISOString(),
        completedAt: overrides.completedAt !== undefined ? overrides.completedAt : new Date("2024-01-01T10:05:00Z").toISOString(),
        output: overrides.output ?? "",
        chainId: overrides.chainId ?? "abc12345",
        attempt: overrides.attempt ?? 1,
        pullRequests: overrides.pullRequests,
        nextRetryAt: overrides.nextRetryAt,
        estimatedDurationSeconds: overrides.estimatedDurationSeconds,
        parentTaskId: overrides.parentTaskId,
    };

    const branch = overrides.branch === null
        ? undefined
        : overrides.branch === undefined
            ? { name: "impl/abc12345", createdAt: "2024-01-01T00:00:00.000Z" }
            : typeof overrides.branch === "string"
                ? { name: overrides.branch, createdAt: "2024-01-01T00:00:00.000Z" }
                : overrides.branch;

    return {
        id: data.taskId as TaskId,
        data,
        branch,
        title: overrides.title ?? "Test task",
        project: { data: { errorRetry } },
        isActive: () => ["queued", "starting", "interrupted", "running", "retrying"].includes(data.status),
    };
}

function makeConfig(maxAttempts?: number): Partial<Config> {
    return {
        server: { workspaceDir: "/tmp/test", adminPassword: ADMIN_PASSWORD, metaCpus: 0.4, sandboxCpus: 0.4 },
        projects: {
            "my-project": {
                data: {
                    repositories: [],
                    claudeCode: { command: "claude", timeoutSeconds: 3600 },
                    ...(maxAttempts !== undefined
                        ? { errorRetry: { maxAttempts, delaySeconds: 60 } }
                        : {})
                }
            }
        } as unknown as Config["projects"]
    };
}

function makeTaskManager(tasks: any[], overrides: Partial<TaskManager> = {}): Partial<TaskManager> {
    return {
        listAllTasks: vi.fn(() => tasks),
        ...overrides,
    };
}

function createApp(tasks: any[], configOverride?: Partial<Config>, tmOverrides?: Partial<TaskManager>): express.Express {
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
        const task = makeTask({ attempt: 3, errorRetry: { maxAttempts: 5, delaySeconds: 60 } });
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
            nextRetryAt,
            errorRetry: { maxAttempts: 5, delaySeconds: 60 }
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

    it("includes estimatedDurationSeconds in task list when available", () => {
        const task = makeTask({
            status: "running",
            completedAt: null,
            estimatedDurationSeconds: 600
        });
        const tm = makeTaskManager([task]) as unknown as TaskManager;
        const cfg = makeConfig() as unknown as Config;

        const data = buildDashboardData(tm, cfg);
        const taskList = data.tasks as Array<{ taskId: string; estimatedDurationSeconds: number | null }>;

        expect(taskList[0].estimatedDurationSeconds).toBe(600);
    });

    it("includes null estimatedDurationSeconds when not set", () => {
        const task = makeTask({ status: "completed" });
        const tm = makeTaskManager([task]) as unknown as TaskManager;
        const cfg = makeConfig() as unknown as Config;

        const data = buildDashboardData(tm, cfg);
        const taskList = data.tasks as Array<{ taskId: string; estimatedDurationSeconds: number | null }>;

        expect(taskList[0].estimatedDurationSeconds).toBeNull();
    });
});

describe("GET /dashboard/api/task/:taskId - estimatedDurationSeconds", () => {
    it("returns estimatedDurationSeconds when set on task", async () => {
        const task = makeTask({ estimatedDurationSeconds: 900 });
        const app = createApp([task], makeConfig() as unknown as Config);

        const res = await request(app)
            .get("/dashboard/api/task/abc12345")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.body.estimatedDurationSeconds).toBe(900);
    });

    it("returns null estimatedDurationSeconds when not set", async () => {
        const task = makeTask();
        const app = createApp([task], makeConfig() as unknown as Config);

        const res = await request(app)
            .get("/dashboard/api/task/abc12345")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.body.estimatedDurationSeconds).toBeNull();
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
        const retryTask = vi.fn().mockImplementation(() => { throw new TaskActiveError("failed"); });
        const app = createApp([task], makeConfig(), { retryTask } as any);

        const res = await request(app)
            .post("/dashboard/api/task/abc12345/retry-now")
            .set("Cookie", AUTH_COOKIE)
            .send({});

        expect(res.status).toBe(409);
    });

    it("returns queued status after immediate retry of retrying task", async () => {
        const nextRetryAt = new Date(Date.now() + 60_000).toISOString();
        const task = makeTask({ status: "retrying", completedAt: null, nextRetryAt });
        const retriedTask = makeTask({ status: "queued", completedAt: null });
        const retryTask = vi.fn().mockReturnValue(retriedTask);
        const app = createApp([task], makeConfig(), { retryTask } as any);

        const res = await request(app)
            .post("/dashboard/api/task/abc12345/retry-now")
            .set("Cookie", AUTH_COOKIE)
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("queued");
        expect(retryTask).toHaveBeenCalledWith("my-project", "abc12345");
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

describe("dashboard HTML - Scheduled Retry badge", () => {
    it("shows 'Scheduled Retry' text instead of 'Retrying' for retrying tasks", async () => {
        const task = makeTask({ status: "retrying", completedAt: null });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain("Scheduled Retry");
        expect(res.text).not.toContain("'Retrying'");
    });

    it("uses clock SVG icon instead of spinning badge for retrying status", async () => {
        const task = makeTask({ status: "retrying", completedAt: null });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        // clock SVG variable should be defined and used for retrying
        expect(res.text).toContain("badge-clock-ico");
        // badge() function should use _clock for retrying, not _spin+'Retrying'
        expect(res.text).toContain("_clock+'Scheduled Retry'");
    });

    it("includes badge-clock-ico CSS class in dashboard HTML", async () => {
        const task = makeTask({ status: "retrying", completedAt: null });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain(".badge-clock-ico{");
    });

    it("project card shows 'scheduled' label for retrying tasks instead of 'retrying'", async () => {
        const task = makeTask({ status: "retrying", completedAt: null });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        // The project stats rendering uses 'scheduled' for retrying count (not 'retrying')
        expect(res.text).toContain("scheduled</span>");
        // Should not use 'retrying' label in project stats
        expect(res.text).not.toContain("retrying</span>");
    });
});

describe("dashboard HTML - unviewed completed task highlight", () => {
    it("includes b-completed-new CSS class for unviewed completed badge styling", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain(".b-completed-new{");
    });

    it("includes tr-completed-new CSS class for unviewed completed row styling", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain(".tr-completed-new td:first-child{border-left:3px solid #34d399!important}");
    });

    it("includes badge-new-dot CSS class for pulsing new indicator dot", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain(".badge-new-dot{");
    });

    it("includes viewedTasks Set initialized from localStorage", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain("viewedTasks");
        expect(res.text).toContain("seenCompletedTasks");
    });

    it("openTask marks task as viewed in localStorage", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        // openTask should add to viewedTasks and persist to localStorage
        expect(res.text).toContain("viewedTasks.add(taskId)");
        expect(res.text).toContain("localStorage.setItem('seenCompletedTasks'");
    });

    it("badge function accepts taskId parameter for unviewed detection", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        // badge function signature includes taskId
        expect(res.text).toContain("function badge(s,completedAt,taskId)");
        // uses isNew logic
        expect(res.text).toContain("isNew");
        expect(res.text).toContain("b-completed-new");
    });

    it("includes badge-new-glow animation keyframes for unviewed completed badge", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain("badge-new-glow");
    });
});

describe("buildDashboardData - PR stats separated into openPrs and draftPrs", () => {
    it("counts only truly open PRs in openPrs", () => {
        const tasks = [
            makeTask({
                pullRequests: [
                    { repo: "org/repo", url: "https://github.com/org/repo/pull/1", state: "open" },
                    { repo: "org/repo", url: "https://github.com/org/repo/pull/2", state: "draft" },
                    { repo: "org/repo", url: "https://github.com/org/repo/pull/3", state: "merged" },
                    { repo: "org/repo", url: "https://github.com/org/repo/pull/4", state: "closed" },
                ]
            })
        ];
        const tm = makeTaskManager(tasks) as unknown as TaskManager;
        const cfg = makeConfig() as unknown as Config;

        const data = buildDashboardData(tm, cfg);

        expect(data.stats.openPrs).toBe(1);
        expect(data.stats.draftPrs).toBe(1);
    });

    it("counts draft PRs only in draftPrs, not in openPrs", () => {
        const tasks = [
            makeTask({
                pullRequests: [
                    { repo: "org/repo", url: "https://github.com/org/repo/pull/1", state: "draft" },
                ]
            }),
            makeTask({
                taskId: "bbb22222",
                pullRequests: [
                    { repo: "org/repo", url: "https://github.com/org/repo/pull/2", state: "draft" },
                ]
            })
        ];
        const tm = makeTaskManager(tasks) as unknown as TaskManager;
        const cfg = makeConfig() as unknown as Config;

        const data = buildDashboardData(tm, cfg);

        expect(data.stats.openPrs).toBe(0);
        expect(data.stats.draftPrs).toBe(2);
    });

    it("returns zero for both when no PRs exist", () => {
        const tasks = [makeTask({ pullRequests: [] })];
        const tm = makeTaskManager(tasks) as unknown as TaskManager;
        const cfg = makeConfig() as unknown as Config;

        const data = buildDashboardData(tm, cfg);

        expect(data.stats.openPrs).toBe(0);
        expect(data.stats.draftPrs).toBe(0);
    });

    it("does not count merged or closed PRs in either stat", () => {
        const tasks = [
            makeTask({
                pullRequests: [
                    { repo: "org/repo", url: "https://github.com/org/repo/pull/1", state: "merged" },
                    { repo: "org/repo", url: "https://github.com/org/repo/pull/2", state: "closed" },
                ]
            })
        ];
        const tm = makeTaskManager(tasks) as unknown as TaskManager;
        const cfg = makeConfig() as unknown as Config;

        const data = buildDashboardData(tm, cfg);

        expect(data.stats.openPrs).toBe(0);
        expect(data.stats.draftPrs).toBe(0);
    });
});

describe("dashboard HTML - PR stat cards", () => {
    it("includes Open PRs stat card in stats bar", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain("stat-open-prs");
        expect(res.text).toContain("Open PRs");
        expect(res.text).toContain('id="spr"');
    });

    it("includes Draft PRs stat card in stats bar", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain("stat-draft-prs");
        expect(res.text).toContain("Draft PRs");
        expect(res.text).toContain('id="sdpr"');
    });

    it("includes draft-prs filter button", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain('data-filter="draft-prs"');
        expect(res.text).toContain("Draft PRs");
    });
});

describe("dashboard HTML - bulk selection UI", () => {
    it("includes checkbox column in table header", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain('id="cb-all"');
        expect(res.text).toContain("th-cb");
    });

    it("includes bulk action bar HTML", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain('id="bulk-bar"');
        expect(res.text).toContain("bulk-bar");
        expect(res.text).toContain("Retry Selected");
        expect(res.text).toContain("Cancel Selected");
    });

    it("includes bulk selection JavaScript functions", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain("toggleTaskSelection");
        expect(res.text).toContain("toggleSelectAll");
        expect(res.text).toContain("bulkRetry");
        expect(res.text).toContain("bulkCancel");
        expect(res.text).toContain("clearSelection");
        expect(res.text).toContain("selectedTaskIds");
    });

    it("includes CSS for bulk bar and checkboxes", async () => {
        const task = makeTask({ status: "completed" });
        const app = createApp([task]);

        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.text).toContain(".bulk-bar{");
        expect(res.text).toContain(".task-cb{");
        expect(res.text).toContain(".th-cb");
    });
});

describe("POST /dashboard/api/tasks/bulk-cancel", () => {
    it("returns 401 without authentication", async () => {
        const app = createApp([]);

        const res = await request(app)
            .post("/dashboard/api/tasks/bulk-cancel")
            .send({ taskIds: ["abc12345"] });

        expect(res.status).toBe(401);
    });

    it("returns 400 when taskIds is missing", async () => {
        const app = createApp([]);

        const res = await request(app)
            .post("/dashboard/api/tasks/bulk-cancel")
            .set("Cookie", AUTH_COOKIE)
            .send({});

        expect(res.status).toBe(400);
    });

    it("returns 400 when taskIds is empty array", async () => {
        const app = createApp([]);

        const res = await request(app)
            .post("/dashboard/api/tasks/bulk-cancel")
            .set("Cookie", AUTH_COOKIE)
            .send({ taskIds: [] });

        expect(res.status).toBe(400);
    });

    it("cancels multiple tasks and returns succeeded count", async () => {
        const task1 = makeTask({ taskId: "abc12345", status: "running" });
        const task2 = makeTask({ taskId: "bbb22222", status: "queued" });
        const cancelTask = vi.fn().mockImplementation((projectId, taskId) => {
            const t = [task1, task2].find((t) => t.id === taskId);
            return { ...t, data: { ...t?.data, status: "cancelled" } };
        });
        const app = createApp([task1, task2], makeConfig(), { cancelTask } as any);

        const res = await request(app)
            .post("/dashboard/api/tasks/bulk-cancel")
            .set("Cookie", AUTH_COOKIE)
            .send({ taskIds: ["abc12345", "bbb22222"] });

        expect(res.status).toBe(200);
        expect(res.body.succeeded).toBe(2);
        expect(res.body.failed).toBe(0);
        expect(cancelTask).toHaveBeenCalledTimes(2);
    });

    it("returns partial success when some tasks are not found", async () => {
        const task1 = makeTask({ taskId: "abc12345", status: "running" });
        const cancelTask = vi.fn().mockResolvedValue(task1);
        const app = createApp([task1], makeConfig(), { cancelTask } as any);

        const res = await request(app)
            .post("/dashboard/api/tasks/bulk-cancel")
            .set("Cookie", AUTH_COOKIE)
            .send({ taskIds: ["abc12345", "nonexistent"] });

        expect(res.status).toBe(200);
        expect(res.body.succeeded).toBe(1);
        expect(res.body.failed).toBe(1);
        expect(res.body.errors).toHaveLength(1);
    });
});

describe("POST /dashboard/api/tasks/bulk-retry", () => {
    it("returns 401 without authentication", async () => {
        const app = createApp([]);

        const res = await request(app)
            .post("/dashboard/api/tasks/bulk-retry")
            .send({ taskIds: ["abc12345"] });

        expect(res.status).toBe(401);
    });

    it("returns 400 when taskIds is missing", async () => {
        const app = createApp([]);

        const res = await request(app)
            .post("/dashboard/api/tasks/bulk-retry")
            .set("Cookie", AUTH_COOKIE)
            .send({});

        expect(res.status).toBe(400);
    });

    it("retries multiple tasks and returns succeeded count", async () => {
        const task1 = makeTask({ taskId: "abc12345", status: "failed" });
        const task2 = makeTask({ taskId: "bbb22222", status: "failed" });
        const retriedTask = makeTask({ taskId: "abc12345", status: "queued" });
        const retryTask = vi.fn().mockReturnValue(retriedTask);
        const app = createApp([task1, task2], makeConfig(), { retryTask } as any);

        const res = await request(app)
            .post("/dashboard/api/tasks/bulk-retry")
            .set("Cookie", AUTH_COOKIE)
            .send({ taskIds: ["abc12345", "bbb22222"] });

        expect(res.status).toBe(200);
        expect(res.body.succeeded).toBe(2);
        expect(res.body.failed).toBe(0);
        expect(retryTask).toHaveBeenCalledTimes(2);
    });

    it("returns partial success when some tasks not found", async () => {
        const task1 = makeTask({ taskId: "abc12345", status: "failed" });
        const retriedTask = makeTask({ taskId: "abc12345", status: "queued" });
        const retryTask = vi.fn().mockReturnValue(retriedTask);
        const app = createApp([task1], makeConfig(), { retryTask } as any);

        const res = await request(app)
            .post("/dashboard/api/tasks/bulk-retry")
            .set("Cookie", AUTH_COOKIE)
            .send({ taskIds: ["abc12345", "nonexistent"] });

        expect(res.status).toBe(200);
        expect(res.body.succeeded).toBe(1);
        expect(res.body.failed).toBe(1);
        expect(res.body.errors).toHaveLength(1);
    });
});
