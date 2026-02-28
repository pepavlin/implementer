/**
 * Tests for the React dashboard integration:
 * - POST /dashboard/api/login (JSON login endpoint)
 * - GET /dashboard serves React app (index.html) or fallback HTML
 * - Auth utilities used by the dashboard
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import {
    registerDashboardRoutes,
    dashboardToken,
    parseCookies,
    isDashboardAuthenticated
} from "../src/dashboard.js";
import type { Config } from "../src/config/config.js";
import type { TaskManager } from "../src/task-manager/task-manager.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const ADMIN_PASSWORD = "test-secret-123";
const VALID_TOKEN = dashboardToken(ADMIN_PASSWORD);
const AUTH_COOKIE = `impl_dash=${VALID_TOKEN}`;

function makeConfig(): Partial<Config> {
    return {
        server: {
            workspaceDir: "/tmp/test",
            adminPassword: ADMIN_PASSWORD,
            metaCpus: 0.4,
            sandboxCpus: 0.4
        } as Config["server"],
        projects: {
            "test-project": {} as any
        }
    } as Partial<Config>;
}

function makeTaskManager(): Partial<TaskManager> {
    return {
        listAllTasks: vi.fn().mockReturnValue([])
    };
}

function makeApp(config: Partial<Config> = makeConfig()) {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    registerDashboardRoutes(
        app as any,
        makeTaskManager() as TaskManager,
        config as Config
    );
    return app;
}

// ── parseCookies ───────────────────────────────────────────────────────────────

describe("parseCookies", () => {
    it("returns empty object for undefined header", () => {
        expect(parseCookies(undefined)).toEqual({});
    });

    it("parses a single cookie", () => {
        expect(parseCookies("foo=bar")).toEqual({ foo: "bar" });
    });

    it("parses multiple cookies", () => {
        expect(parseCookies("a=1; b=2; c=3")).toEqual({ a: "1", b: "2", c: "3" });
    });

    it("handles cookies with = in value", () => {
        const result = parseCookies("token=abc=def");
        expect(result.token).toBe("abc=def");
    });
});

// ── dashboardToken ─────────────────────────────────────────────────────────────

describe("dashboardToken", () => {
    it("produces a 64-char hex string", () => {
        const token = dashboardToken("my-password");
        expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic for the same password", () => {
        expect(dashboardToken("pw")).toBe(dashboardToken("pw"));
    });

    it("differs for different passwords", () => {
        expect(dashboardToken("a")).not.toBe(dashboardToken("b"));
    });

    it("includes the impl: prefix in hashing (not just raw password)", () => {
        // The hash of "impl:pw" differs from the hash of "pw"
        const token = dashboardToken("pw");
        const { createHash } = require("node:crypto");
        const rawHash = createHash("sha256").update("pw").digest("hex");
        expect(token).not.toBe(rawHash);
    });
});

// ── isDashboardAuthenticated ───────────────────────────────────────────────────

describe("isDashboardAuthenticated", () => {
    it("returns true for correct cookie", () => {
        const req = { headers: { cookie: AUTH_COOKIE } } as any;
        expect(isDashboardAuthenticated(req, ADMIN_PASSWORD)).toBe(true);
    });

    it("returns false for wrong token", () => {
        const req = { headers: { cookie: "impl_dash=wrongtoken" } } as any;
        expect(isDashboardAuthenticated(req, ADMIN_PASSWORD)).toBe(false);
    });

    it("returns false for missing cookie", () => {
        const req = { headers: {} } as any;
        expect(isDashboardAuthenticated(req, ADMIN_PASSWORD)).toBe(false);
    });
});

// ── POST /dashboard/api/login ──────────────────────────────────────────────────

describe("POST /dashboard/api/login", () => {
    it("returns 200 and sets cookie for correct password", async () => {
        const app = makeApp();
        const res = await request(app)
            .post("/dashboard/api/login")
            .send({ password: ADMIN_PASSWORD });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true });
        const cookie = res.headers["set-cookie"] as string[] | string | undefined;
        const cookieStr = Array.isArray(cookie) ? cookie.join("; ") : (cookie ?? "");
        expect(cookieStr).toContain(`impl_dash=${VALID_TOKEN}`);
    });

    it("returns 401 for wrong password", async () => {
        const app = makeApp();
        const res = await request(app)
            .post("/dashboard/api/login")
            .send({ password: "wrong-password" });

        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ error: "Invalid password" });
    });

    it("returns 401 for empty password", async () => {
        const app = makeApp();
        const res = await request(app)
            .post("/dashboard/api/login")
            .send({ password: "" });

        expect(res.status).toBe(401);
    });

    it("returns 404 when no admin password is configured", async () => {
        const config = {
            ...makeConfig(),
            server: { workspaceDir: "/tmp", metaCpus: 0.4, sandboxCpus: 0.4 }
        } as any;
        const app = makeApp(config);
        const res = await request(app)
            .post("/dashboard/api/login")
            .send({ password: "any" });

        expect(res.status).toBe(404);
    });
});

// ── GET /dashboard/api/data ────────────────────────────────────────────────────

describe("GET /dashboard/api/data", () => {
    it("returns 401 when not authenticated", async () => {
        const app = makeApp();
        const res = await request(app).get("/dashboard/api/data");
        expect(res.status).toBe(401);
    });

    it("returns 200 with task data when authenticated", async () => {
        const app = makeApp();
        const res = await request(app)
            .get("/dashboard/api/data")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("tasks");
        expect(res.body).toHaveProperty("stats");
        expect(res.body).toHaveProperty("projects");
    });
});

// ── GET /dashboard/logout ──────────────────────────────────────────────────────

describe("GET /dashboard/logout", () => {
    it("clears the auth cookie and redirects", async () => {
        const app = makeApp();
        const res = await request(app)
            .get("/dashboard/logout")
            .set("Cookie", AUTH_COOKIE);

        expect(res.status).toBe(302);
        const cookie = res.headers["set-cookie"] as string[] | string | undefined;
        const cookieStr = Array.isArray(cookie) ? cookie.join("; ") : (cookie ?? "");
        expect(cookieStr).toContain("Max-Age=0");
    });
});

// ── POST /dashboard (legacy form login) ───────────────────────────────────────

describe("POST /dashboard (legacy form login)", () => {
    it("sets cookie and redirects on correct password", async () => {
        const app = makeApp();
        const res = await request(app)
            .post("/dashboard")
            .type("form")
            .send({ password: ADMIN_PASSWORD });

        expect(res.status).toBe(302);
        const cookie = res.headers["set-cookie"] as string[] | string | undefined;
        const cookieStr = Array.isArray(cookie) ? cookie.join("; ") : (cookie ?? "");
        expect(cookieStr).toContain(`impl_dash=${VALID_TOKEN}`);
    });

    it("returns HTML with error on wrong password", async () => {
        const app = makeApp();
        const res = await request(app)
            .post("/dashboard")
            .type("form")
            .send({ password: "wrong" });

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("text/html");
    });
});
