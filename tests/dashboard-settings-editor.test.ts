import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { registerDashboardRoutes, dashboardToken } from "../src/dashboard.js";
import type { Config } from "../src/config/config.js";
import type { TaskManager } from "../src/task-manager/task-manager.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ADMIN_PASSWORD = "test-password";
const AUTH_TOKEN = dashboardToken(ADMIN_PASSWORD);
const AUTH_COOKIE = `impl_dash=${AUTH_TOKEN}`;

function createApp(): express.Express {
    const app = express();
    app.use(express.json());
    const tm = {
        listAllTasks: vi.fn(() => []),
        isPaused: vi.fn().mockReturnValue(false),
    } as unknown as TaskManager;
    const cfg = {
        server: { workspaceDir: "/tmp/test", adminPassword: ADMIN_PASSWORD, metaCpus: 0.4, sandboxCpus: 0.4 },
        projects: {} as unknown as Config["projects"],
    } as unknown as Config;
    registerDashboardRoutes(app, tm, cfg);
    return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Dashboard settings editor", () => {
    it("renders config editor with line numbers container", async () => {
        const app = createApp();
        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);
        expect(res.status).toBe(200);
        expect(res.text).toContain('id="settings-line-nums"');
        expect(res.text).toContain('class="cfg-line-nums"');
    });

    it("renders config editor with syntax highlight overlay", async () => {
        const app = createApp();
        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);
        expect(res.text).toContain('id="settings-highlight"');
        expect(res.text).toContain('class="cfg-highlight"');
    });

    it("renders textarea with cfg-textarea class", async () => {
        const app = createApp();
        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);
        expect(res.text).toContain('class="cfg-textarea"');
        expect(res.text).toContain('id="settings-editor"');
    });

    it("renders editor wrapper with content div for scroll sync", async () => {
        const app = createApp();
        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);
        expect(res.text).toContain('class="cfg-editor-wrap"');
        expect(res.text).toContain('id="settings-editor-inner"');
        expect(res.text).toContain('class="cfg-editor-content"');
    });

    it("includes Tab key handler with multi-line indent/unindent", async () => {
        const app = createApp();
        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);
        expect(res.text).toContain("e.key==='Tab'");
        expect(res.text).toContain("e.preventDefault()");
        // Multi-line indent support
        expect(res.text).toContain("Multi-line indent");
        expect(res.text).toContain("Multi-line unindent");
    });

    it("includes Enter key auto-indent handler", async () => {
        const app = createApp();
        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);
        expect(res.text).toContain("e.key==='Enter'");
        // Auto-indent after colon
        expect(res.text).toContain("endsWith(':')");
    });

    it("includes YAML syntax highlighting function", async () => {
        const app = createApp();
        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);
        expect(res.text).toContain("highlightYaml");
        expect(res.text).toContain("cfg-hl-key");
        expect(res.text).toContain("cfg-hl-comment");
    });

    it("includes line number update function", async () => {
        const app = createApp();
        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);
        expect(res.text).toContain("updateLineNums");
    });

    it("uses scroll container for line number sync instead of transform", async () => {
        const app = createApp();
        const res = await request(app)
            .get("/dashboard")
            .set("Cookie", AUTH_COOKIE);
        // Should use scrollBox-based sync, not transform hack
        expect(res.text).toContain("settings-editor-inner");
        expect(res.text).toContain("scrollBox.scrollTop");
        expect(res.text).not.toContain("hlEl.style.transform");
    });
});
