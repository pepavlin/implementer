import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { createServer } from "../src/server.js";
import type { TaskManager } from "../src/task-manager/task-manager.js";
import type { Config } from "../src/config/config.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PROJECT_ID = "webhook-project";
const WEBHOOK_SECRET = "whsec_test_secret_token";
const REPO_URL = "https://github.com/my-org/my-repo.git";

function signPayload(body: string, secret: string): string {
    return (
        "sha256=" +
        crypto.createHmac("sha256", secret).update(body).digest("hex")
    );
}

function makeConfig(overrides: Record<string, unknown> = {}): Config {
    const projects: Record<string, unknown> = {
        [PROJECT_ID]: {
            data: {
                apiKey: "test-api-key",
                repositories: [
                    {
                        name: "my-repo",
                        url: REPO_URL,
                        defaultBranch: "main"
                    }
                ],
                claudeCode: { command: "claude", timeoutSeconds: 3600 },
                webhookSecret: WEBHOOK_SECRET,
                ...overrides
            }
        }
    };
    return {
        server: {
            workspaceDir: "/tmp/test",
            metaCpus: 0.4,
            sandboxCpus: 0.4
        },
        projects,
        configPath: "/tmp/test/config.yaml",
        getProjectIdByToken: (token: string) => {
            if (token === "test-api-key") return PROJECT_ID;
            return null;
        }
    } as unknown as Config;
}

function makeConfigWithoutSecret(): Config {
    return makeConfig({ webhookSecret: undefined });
}

function makeMockTaskManager(): TaskManager {
    return {
        createNewTask: vi.fn(),
        getTask: vi.fn(),
        listTasks: vi.fn().mockReturnValue([]),
        listAllTasks: vi.fn().mockReturnValue([]),
        getOutput: vi.fn().mockReturnValue(""),
        retryTask: vi.fn(),
        cancelTask: vi.fn(),
        isPaused: vi.fn().mockReturnValue(false),
        pause: vi.fn(),
        resume: vi.fn(),
        setTaskPriority: vi.fn(),
        markTaskRead: vi.fn(),
        triggerProjectPoll: vi.fn().mockResolvedValue(undefined)
    } as unknown as TaskManager;
}

function makePrPayload(
    action: string,
    repoFullName = "my-org/my-repo"
): object {
    return {
        action,
        number: 42,
        pull_request: {
            id: 1,
            number: 42,
            state: "open",
            title: "Test PR",
            html_url: `https://github.com/${repoFullName}/pull/42`
        },
        repository: {
            full_name: repoFullName,
            html_url: `https://github.com/${repoFullName}`
        },
        sender: { login: "octocat" }
    };
}

function makeCheckRunPayload(
    action: string,
    repoFullName = "my-org/my-repo"
): object {
    return {
        action,
        check_run: {
            id: 1,
            name: "build",
            status: "completed",
            conclusion: "success",
            head_sha: "abc123"
        },
        repository: {
            full_name: repoFullName,
            html_url: `https://github.com/${repoFullName}`
        },
        sender: { login: "github-actions[bot]" }
    };
}

function makeWorkflowRunPayload(
    action: string,
    repoFullName = "my-org/my-repo"
): object {
    return {
        action,
        workflow_run: {
            id: 1,
            name: "CI",
            status: "completed",
            conclusion: "success",
            head_branch: "main",
            head_sha: "abc123"
        },
        repository: {
            full_name: repoFullName,
            html_url: `https://github.com/${repoFullName}`
        },
        sender: { login: "github-actions[bot]" }
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /webhook/github/:projectId", () => {
    let tm: TaskManager;

    beforeEach(() => {
        tm = makeMockTaskManager();
    });

    // ── Authentication & validation ─────────────────────────────────────

    it("returns 404 for unknown project", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify(makePrPayload("opened"));

        const res = await request(app)
            .post("/webhook/github/nonexistent-project")
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "pull_request")
            .set("X-Hub-Signature-256", signPayload(payload, WEBHOOK_SECRET))
            .send(payload)
            .expect(404);

        expect(res.body.error).toContain("Project not found");
    });

    it("returns 400 when webhookSecret is not configured", async () => {
        const app = createServer(tm, makeConfigWithoutSecret());
        const payload = JSON.stringify(makePrPayload("opened"));

        const res = await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "pull_request")
            .set("X-Hub-Signature-256", signPayload(payload, "any-secret"))
            .send(payload)
            .expect(400);

        expect(res.body.error).toContain("not configured");
    });

    it("returns 401 for invalid signature", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify(makePrPayload("opened"));

        const res = await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "pull_request")
            .set("X-Hub-Signature-256", signPayload(payload, "wrong-secret"))
            .send(payload)
            .expect(401);

        expect(res.body.error).toContain("Invalid webhook signature");
    });

    it("returns 401 when signature header is missing", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify(makePrPayload("opened"));

        await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "pull_request")
            .send(payload)
            .expect(401);
    });

    it("returns 400 when X-GitHub-Event header is missing", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify(makePrPayload("opened"));

        const res = await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-Hub-Signature-256", signPayload(payload, WEBHOOK_SECRET))
            .send(payload)
            .expect(400);

        expect(res.body.error).toContain("Missing X-GitHub-Event header");
    });

    // ── Accepted pull_request events ────────────────────────────────────

    it("accepts pull_request opened and triggers poll", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify(makePrPayload("opened"));

        const res = await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "pull_request")
            .set("X-Hub-Signature-256", signPayload(payload, WEBHOOK_SECRET))
            .send(payload)
            .expect(200);

        expect(res.body.accepted).toBe(true);
        expect(res.body.reason).toBe("pull_request opened");
        expect(tm.triggerProjectPoll).toHaveBeenCalledWith(PROJECT_ID);
    });

    it("accepts pull_request closed and triggers poll", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify(makePrPayload("closed"));

        const res = await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "pull_request")
            .set("X-Hub-Signature-256", signPayload(payload, WEBHOOK_SECRET))
            .send(payload)
            .expect(200);

        expect(res.body.accepted).toBe(true);
        expect(res.body.reason).toBe("pull_request closed");
        expect(tm.triggerProjectPoll).toHaveBeenCalledWith(PROJECT_ID);
    });

    it("accepts pull_request synchronize and triggers poll", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify(makePrPayload("synchronize"));

        const res = await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "pull_request")
            .set("X-Hub-Signature-256", signPayload(payload, WEBHOOK_SECRET))
            .send(payload)
            .expect(200);

        expect(res.body.accepted).toBe(true);
        expect(tm.triggerProjectPoll).toHaveBeenCalledWith(PROJECT_ID);
    });

    // ── Ignored events ──────────────────────────────────────────────────

    it("ignores pull_request labeled (returns accepted: false)", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify(makePrPayload("labeled"));

        const res = await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "pull_request")
            .set("X-Hub-Signature-256", signPayload(payload, WEBHOOK_SECRET))
            .send(payload)
            .expect(200);

        expect(res.body.accepted).toBe(false);
        expect(tm.triggerProjectPoll).not.toHaveBeenCalled();
    });

    it("ignores push events", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify({
            ref: "refs/heads/main",
            repository: {
                full_name: "my-org/my-repo",
                html_url: "https://github.com/my-org/my-repo"
            }
        });

        const res = await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "push")
            .set("X-Hub-Signature-256", signPayload(payload, WEBHOOK_SECRET))
            .send(payload)
            .expect(200);

        expect(res.body.accepted).toBe(false);
        expect(tm.triggerProjectPoll).not.toHaveBeenCalled();
    });

    // ── check_run events ────────────────────────────────────────────────

    it("accepts check_run completed and triggers poll", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify(makeCheckRunPayload("completed"));

        const res = await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "check_run")
            .set("X-Hub-Signature-256", signPayload(payload, WEBHOOK_SECRET))
            .send(payload)
            .expect(200);

        expect(res.body.accepted).toBe(true);
        expect(res.body.reason).toBe("check_run completed");
        expect(tm.triggerProjectPoll).toHaveBeenCalledWith(PROJECT_ID);
    });

    it("ignores check_run created", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify(makeCheckRunPayload("created"));

        const res = await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "check_run")
            .set("X-Hub-Signature-256", signPayload(payload, WEBHOOK_SECRET))
            .send(payload)
            .expect(200);

        expect(res.body.accepted).toBe(false);
        expect(tm.triggerProjectPoll).not.toHaveBeenCalled();
    });

    // ── workflow_run events ─────────────────────────────────────────────

    it("accepts workflow_run completed and triggers poll", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify(makeWorkflowRunPayload("completed"));

        const res = await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "workflow_run")
            .set("X-Hub-Signature-256", signPayload(payload, WEBHOOK_SECRET))
            .send(payload)
            .expect(200);

        expect(res.body.accepted).toBe(true);
        expect(res.body.reason).toBe("workflow_run completed");
        expect(tm.triggerProjectPoll).toHaveBeenCalledWith(PROJECT_ID);
    });

    // ── Repository mismatch ─────────────────────────────────────────────

    it("rejects events from repos not configured for the project", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify(
            makePrPayload("opened", "other-org/other-repo")
        );

        const res = await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "pull_request")
            .set("X-Hub-Signature-256", signPayload(payload, WEBHOOK_SECRET))
            .send(payload)
            .expect(200);

        expect(res.body.accepted).toBe(false);
        expect(res.body.reason).toContain("not configured for this project");
        expect(tm.triggerProjectPoll).not.toHaveBeenCalled();
    });

    // ── Webhook does not require Bearer token auth ──────────────────────

    it("does not require Bearer token authentication", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify(makePrPayload("opened"));

        // Note: no Authorization header set
        const res = await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "pull_request")
            .set("X-Hub-Signature-256", signPayload(payload, WEBHOOK_SECRET))
            .send(payload)
            .expect(200);

        expect(res.body.accepted).toBe(true);
    });

    // ── Delivery ID is logged ───────────────────────────────────────────

    it("accepts events with X-GitHub-Delivery header", async () => {
        const app = createServer(tm, makeConfig());
        const payload = JSON.stringify(makePrPayload("opened"));

        const res = await request(app)
            .post(`/webhook/github/${PROJECT_ID}`)
            .set("Content-Type", "application/json")
            .set("X-GitHub-Event", "pull_request")
            .set("X-Hub-Signature-256", signPayload(payload, WEBHOOK_SECRET))
            .set("X-GitHub-Delivery", "abc123-delivery-id")
            .send(payload)
            .expect(200);

        expect(res.body.accepted).toBe(true);
    });
});
