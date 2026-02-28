import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { registerDashboardRoutes, dashboardToken } from "../src/dashboard.js";
import type { TaskId } from "../src/types.js";
import type { Config } from "../src/config/config.js";
import type { TaskManager } from "../src/task-manager/task-manager.js";

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

function makeConfig(): Partial<Config> {
    return {
        server: { workspaceDir: "/tmp/test", adminPassword: ADMIN_PASSWORD, metaCpus: 0.4, sandboxCpus: 0.4 },
        projects: {
            "my-project": {
                data: {
                    repositories: [],
                    claudeCode: { command: "claude", timeoutSeconds: 3600 },
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

describe("Voice Mode — Dashboard HTML", () => {
    let html: string;

    async function getDashboardHtml(): Promise<string> {
        const app = createApp([makeTask()]);
        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);
        return res.text;
    }

    it("renders the voice mode button in the header", async () => {
        html = await getDashboardHtml();
        expect(html).toContain('id="voice-btn"');
        expect(html).toContain("toggleVoiceMode()");
        expect(html).toContain("Voice Mode");
    });

    it("renders the voice panel structure", async () => {
        html = await getDashboardHtml();
        expect(html).toContain('id="voice-panel"');
        expect(html).toContain('class="voice-panel"');
        expect(html).toContain('id="voice-status-text"');
        expect(html).toContain('id="voice-lang-btn"');
        expect(html).toContain('id="voice-cancel-btn"');
        expect(html).toContain('id="voice-transcript-area"');
        expect(html).toContain('id="voice-transcript-text"');
        expect(html).toContain('id="voice-silence-fill"');
        expect(html).toContain('id="voice-warning"');
        expect(html).toContain('id="voice-submitted"');
    });

    it("renders voice panel hidden by default", async () => {
        html = await getDashboardHtml();
        expect(html).toMatch(/id="voice-panel"[^>]*style="display:none"/);
    });

    it("includes voice mode CSS classes", async () => {
        html = await getDashboardHtml();
        expect(html).toContain(".voice-panel{");
        expect(html).toContain(".voice-target");
        expect(html).toContain(".voice-btn-active{");
        expect(html).toContain(".voice-transcript{");
        expect(html).toContain(".voice-silence-bar{");
        expect(html).toContain(".voice-silence-fill{");
        expect(html).toContain(".voice-flash{");
        expect(html).toContain(".voice-warning{");
        expect(html).toContain(".voice-submitted{");
    });

    it("includes voice CSS variables in dark theme", async () => {
        html = await getDashboardHtml();
        expect(html).toContain("--voice-bg:");
        expect(html).toContain("--voice-border:");
        expect(html).toContain("--voice-fg:");
        expect(html).toContain("--voice-panel-bg:");
        expect(html).toContain("--voice-warn-bg:");
        expect(html).toContain("--voice-warn-fg:");
    });

    it("includes voice CSS variables in light theme", async () => {
        html = await getDashboardHtml();
        // Light theme block should also have voice vars
        const lightThemeMatch = html.match(/\[data-theme=light\]\{[^}]+\}/);
        expect(lightThemeMatch).toBeTruthy();
        expect(lightThemeMatch![0]).toContain("--voice-bg:");
        expect(lightThemeMatch![0]).toContain("--voice-border:");
    });

    it("includes voice-pulse and voice-glow keyframe animations", async () => {
        html = await getDashboardHtml();
        expect(html).toContain("@keyframes voice-pulse");
        expect(html).toContain("@keyframes voice-glow");
        expect(html).toContain("@keyframes voice-flash-in");
        expect(html).toContain("@keyframes voice-flash-out");
    });
});

describe("Voice Mode — JS functions", () => {
    let html: string;

    async function getDashboardHtml(): Promise<string> {
        const app = createApp([makeTask()]);
        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);
        return res.text;
    }

    it("includes all voice mode function definitions", async () => {
        html = await getDashboardHtml();
        const expectedFunctions = [
            "toggleVoiceMode",
            "voiceSelectProject",
            "startVoiceRecognition",
            "stopVoiceRecognition",
            "startSilenceTimer",
            "resetSilenceTimer",
            "clearSilenceTimer",
            "voiceAutoSubmit",
            "voiceCancel",
            "toggleVoiceLang",
            "updateVoicePanel",
            "renderVoiceSubmitted",
            "showVoiceFlash",
            "showVoiceWarning",
            "hideVoiceWarning",
        ];
        for (const fn of expectedFunctions) {
            expect(html).toContain(`function ${fn}(`);
        }
    });

    it("includes voice mode global variables", async () => {
        html = await getDashboardHtml();
        expect(html).toContain("voiceMode=false");
        expect(html).toContain("voiceTarget=null");
        expect(html).toContain("voiceRecognition=null");
        expect(html).toContain("voiceTranscript=''");
        expect(html).toContain("voiceSilenceTimer=null");
        expect(html).toContain("voiceLang='cs-CZ'");
        expect(html).toContain("voiceSubmittedLog=[]");
    });

    it("toggleProject guards for voice mode", async () => {
        html = await getDashboardHtml();
        expect(html).toContain("if(voiceMode){voiceSelectProject(id);return;}");
    });

    it("updateProjHint handles voice mode", async () => {
        html = await getDashboardHtml();
        expect(html).toContain("if(voiceMode){el.textContent=voiceTarget?");
    });

    it("Escape handler handles voice mode", async () => {
        html = await getDashboardHtml();
        expect(html).toContain("if(voiceMode&&voiceTarget){voiceCancel();return;}");
        expect(html).toContain("if(voiceMode){toggleVoiceMode();return;}");
    });

    it("enterSelectionMode exits voice mode first", async () => {
        html = await getDashboardHtml();
        expect(html).toContain("if(voiceMode)toggleVoiceMode();");
    });

    it("renderProjects includes voice-target class logic", async () => {
        html = await getDashboardHtml();
        expect(html).toContain("isVoiceTarget=voiceMode&&voiceTarget===id");
    });

    it("startSilenceTimer uses 4-second silence timeout", async () => {
        html = await getDashboardHtml();
        expect(html).toContain("var duration=4000;");
        expect(html).not.toContain("var duration=6000;");
    });
});

describe("Voice Mode — API regression", () => {
    it("POST /dashboard/api/task still works for voice submissions", async () => {
        const createdTask = makeTask({ taskId: "new123", status: "queued" });
        const createFn = vi.fn(() => createdTask);
        const app = createApp([makeTask()], undefined, {
            createNewTask: createFn as any,
        });

        const res = await request(app)
            .post("/dashboard/api/task")
            .set("Cookie", AUTH_COOKIE)
            .send({ projectId: "my-project", prompt: "Voice dictated task" });

        expect(res.status).toBe(200);
        expect(res.body.taskId).toBe("new123");
        expect(res.body.status).toBe("queued");
        expect(createFn).toHaveBeenCalledWith("my-project", {
            prompt: "Voice dictated task",
            continueTaskId: undefined,
        });
    });

    it("POST /dashboard/api/task rejects empty prompt", async () => {
        const app = createApp([makeTask()]);

        const res = await request(app)
            .post("/dashboard/api/task")
            .set("Cookie", AUTH_COOKIE)
            .send({ projectId: "my-project", prompt: "" });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Prompt is required");
    });

    it("POST /dashboard/api/task rejects invalid project", async () => {
        const app = createApp([makeTask()]);

        const res = await request(app)
            .post("/dashboard/api/task")
            .set("Cookie", AUTH_COOKIE)
            .send({ projectId: "nonexistent", prompt: "Something" });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Invalid or missing project ID");
    });
});

describe("Voice Mode — Responsive CSS", () => {
    it("includes responsive voice panel styles", async () => {
        const app = createApp([makeTask()]);
        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);
        const html = res.text;
        // Inside the 540px media query
        expect(html).toContain(".voice-panel{padding:10px 14px}");
        expect(html).toContain(".voice-status{flex-wrap:wrap;gap:6px}");
    });
});
