import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
    verifyWebhookSignature,
    shouldTriggerPoll,
    extractRepoInfo,
    SUPPORTED_EVENTS,
    type WebhookPayload
} from "../src/webhook-handler.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function signPayload(payload: string, secret: string): string {
    return (
        "sha256=" +
        crypto.createHmac("sha256", secret).update(payload).digest("hex")
    );
}

function makePayload(overrides: Partial<WebhookPayload> = {}): WebhookPayload {
    return {
        action: "opened",
        repository: {
            full_name: "my-org/my-repo",
            html_url: "https://github.com/my-org/my-repo"
        },
        ...overrides
    };
}

const PROJECT_REPO_URLS = [
    "https://github.com/my-org/my-repo.git",
    "https://github.com/my-org/other-repo.git"
];

// ── extractRepoInfo ─────────────────────────────────────────────────────────

describe("extractRepoInfo", () => {
    it("returns full_name and html_url when present", () => {
        const payload = makePayload();
        const info = extractRepoInfo(payload);
        expect(info).toEqual({
            fullName: "my-org/my-repo",
            htmlUrl: "https://github.com/my-org/my-repo"
        });
    });

    it("returns null when repository is undefined", () => {
        const payload = makePayload({ repository: undefined });
        expect(extractRepoInfo(payload)).toBeNull();
    });

    it("returns partial info when only full_name is present", () => {
        const payload = makePayload({
            repository: { full_name: "my-org/my-repo", html_url: "" }
        });
        // html_url is empty string (falsy-ish but still a string)
        const info = extractRepoInfo(payload);
        expect(info).not.toBeNull();
        expect(info!.fullName).toBe("my-org/my-repo");
    });
});

// ── Signature verification ──────────────────────────────────────────────────

describe("verifyWebhookSignature", () => {
    const secret = "test-webhook-secret-123";

    it("returns true for a valid signature", () => {
        const body = '{"action":"opened"}';
        const signature = signPayload(body, secret);
        expect(verifyWebhookSignature(body, secret, signature)).toBe(true);
    });

    it("returns true for a valid signature with Buffer body", () => {
        const body = Buffer.from('{"action":"opened"}');
        const signature = signPayload(body.toString(), secret);
        expect(verifyWebhookSignature(body, secret, signature)).toBe(true);
    });

    it("returns false for an invalid signature", () => {
        const body = '{"action":"opened"}';
        const wrongSignature = signPayload(body, "wrong-secret");
        expect(verifyWebhookSignature(body, secret, wrongSignature)).toBe(
            false
        );
    });

    it("returns false for a tampered payload", () => {
        const body = '{"action":"opened"}';
        const signature = signPayload(body, secret);
        expect(
            verifyWebhookSignature('{"action":"closed"}', secret, signature)
        ).toBe(false);
    });

    it("returns false when signature header is undefined", () => {
        expect(verifyWebhookSignature("body", secret, undefined)).toBe(false);
    });

    it("returns false when signature header is empty", () => {
        expect(verifyWebhookSignature("body", secret, "")).toBe(false);
    });

    it("returns false for a malformed signature (wrong prefix)", () => {
        const body = '{"action":"opened"}';
        const hash = crypto
            .createHmac("sha256", secret)
            .update(body)
            .digest("hex");
        // Missing "sha256=" prefix
        expect(verifyWebhookSignature(body, secret, hash)).toBe(false);
    });

    it("returns false for different-length signatures", () => {
        const body = '{"action":"opened"}';
        expect(verifyWebhookSignature(body, secret, "sha256=tooshort")).toBe(
            false
        );
    });
});

// ── SUPPORTED_EVENTS ────────────────────────────────────────────────────────

describe("SUPPORTED_EVENTS", () => {
    it("includes pull_request, check_run, check_suite, and workflow_run", () => {
        expect(SUPPORTED_EVENTS.has("pull_request")).toBe(true);
        expect(SUPPORTED_EVENTS.has("check_run")).toBe(true);
        expect(SUPPORTED_EVENTS.has("check_suite")).toBe(true);
        expect(SUPPORTED_EVENTS.has("workflow_run")).toBe(true);
    });

    it("does not include random events", () => {
        expect(SUPPORTED_EVENTS.has("push")).toBe(false);
        expect(SUPPORTED_EVENTS.has("issues")).toBe(false);
        expect(SUPPORTED_EVENTS.has("star")).toBe(false);
    });
});

// ── shouldTriggerPoll ───────────────────────────────────────────────────────

describe("shouldTriggerPoll", () => {
    // ── Unsupported events ──────────────────────────────────────────────

    it("rejects unsupported event types", () => {
        const result = shouldTriggerPoll(
            "push",
            makePayload(),
            PROJECT_REPO_URLS
        );
        expect(result.shouldPoll).toBe(false);
        expect(result.reason).toContain("Unsupported event type");
    });

    it("rejects 'issues' event", () => {
        const result = shouldTriggerPoll(
            "issues",
            makePayload(),
            PROJECT_REPO_URLS
        );
        expect(result.shouldPoll).toBe(false);
    });

    // ── Repository matching ─────────────────────────────────────────────

    it("rejects events from unrelated repositories", () => {
        const payload = makePayload({
            repository: {
                full_name: "other-org/other-repo",
                html_url: "https://github.com/other-org/other-repo"
            }
        });
        const result = shouldTriggerPoll(
            "pull_request",
            payload,
            PROJECT_REPO_URLS
        );
        expect(result.shouldPoll).toBe(false);
        expect(result.reason).toContain("not configured for this project");
    });

    it("rejects events with no repository information", () => {
        const payload = makePayload({ repository: undefined });
        const result = shouldTriggerPoll(
            "pull_request",
            payload,
            PROJECT_REPO_URLS
        );
        expect(result.shouldPoll).toBe(false);
        expect(result.reason).toContain("No repository information");
    });

    it("matches repository by html_url (case-insensitive)", () => {
        const payload = makePayload({
            repository: {
                full_name: "My-Org/My-Repo",
                html_url: "https://github.com/My-Org/My-Repo"
            }
        });
        const result = shouldTriggerPoll(
            "pull_request",
            payload,
            PROJECT_REPO_URLS
        );
        expect(result.shouldPoll).toBe(true);
    });

    it("matches repository by full_name against URL suffix", () => {
        const payload = makePayload({
            repository: {
                full_name: "my-org/my-repo",
                html_url: "https://github.com/my-org/my-repo"
            }
        });
        const result = shouldTriggerPoll(
            "pull_request",
            payload,
            // URLs with .git suffix
            ["https://github.com/my-org/my-repo.git"]
        );
        expect(result.shouldPoll).toBe(true);
    });

    // ── pull_request events ─────────────────────────────────────────────

    describe("pull_request events", () => {
        const relevantActions = [
            "opened",
            "closed",
            "reopened",
            "synchronize",
            "ready_for_review",
            "converted_to_draft"
        ];

        for (const action of relevantActions) {
            it(`accepts pull_request ${action}`, () => {
                const payload = makePayload({ action });
                const result = shouldTriggerPoll(
                    "pull_request",
                    payload,
                    PROJECT_REPO_URLS
                );
                expect(result.shouldPoll).toBe(true);
                expect(result.reason).toBe(`pull_request ${action}`);
            });
        }

        const ignoredActions = [
            "labeled",
            "unlabeled",
            "assigned",
            "unassigned",
            "review_requested",
            "edited",
            "locked"
        ];

        for (const action of ignoredActions) {
            it(`ignores pull_request ${action}`, () => {
                const payload = makePayload({ action });
                const result = shouldTriggerPoll(
                    "pull_request",
                    payload,
                    PROJECT_REPO_URLS
                );
                expect(result.shouldPoll).toBe(false);
                expect(result.reason).toContain("not a relevant state change");
            });
        }

        it("ignores pull_request with no action", () => {
            const payload = makePayload({ action: undefined });
            const result = shouldTriggerPoll(
                "pull_request",
                payload,
                PROJECT_REPO_URLS
            );
            expect(result.shouldPoll).toBe(false);
        });
    });

    // ── check_run events ────────────────────────────────────────────────

    describe("check_run events", () => {
        it("accepts check_run completed", () => {
            const payload = makePayload({ action: "completed" });
            const result = shouldTriggerPoll(
                "check_run",
                payload,
                PROJECT_REPO_URLS
            );
            expect(result.shouldPoll).toBe(true);
            expect(result.reason).toBe("check_run completed");
        });

        it("ignores check_run created", () => {
            const payload = makePayload({ action: "created" });
            const result = shouldTriggerPoll(
                "check_run",
                payload,
                PROJECT_REPO_URLS
            );
            expect(result.shouldPoll).toBe(false);
        });

        it("ignores check_run rerequested", () => {
            const payload = makePayload({ action: "rerequested" });
            const result = shouldTriggerPoll(
                "check_run",
                payload,
                PROJECT_REPO_URLS
            );
            expect(result.shouldPoll).toBe(false);
        });
    });

    // ── check_suite events ──────────────────────────────────────────────

    describe("check_suite events", () => {
        it("accepts check_suite completed", () => {
            const payload = makePayload({ action: "completed" });
            const result = shouldTriggerPoll(
                "check_suite",
                payload,
                PROJECT_REPO_URLS
            );
            expect(result.shouldPoll).toBe(true);
            expect(result.reason).toBe("check_suite completed");
        });

        it("ignores check_suite requested", () => {
            const payload = makePayload({ action: "requested" });
            const result = shouldTriggerPoll(
                "check_suite",
                payload,
                PROJECT_REPO_URLS
            );
            expect(result.shouldPoll).toBe(false);
        });
    });

    // ── workflow_run events ─────────────────────────────────────────────

    describe("workflow_run events", () => {
        it("accepts workflow_run completed", () => {
            const payload = makePayload({ action: "completed" });
            const result = shouldTriggerPoll(
                "workflow_run",
                payload,
                PROJECT_REPO_URLS
            );
            expect(result.shouldPoll).toBe(true);
            expect(result.reason).toBe("workflow_run completed");
        });

        it("ignores workflow_run requested", () => {
            const payload = makePayload({ action: "requested" });
            const result = shouldTriggerPoll(
                "workflow_run",
                payload,
                PROJECT_REPO_URLS
            );
            expect(result.shouldPoll).toBe(false);
        });

        it("ignores workflow_run in_progress", () => {
            const payload = makePayload({ action: "in_progress" });
            const result = shouldTriggerPoll(
                "workflow_run",
                payload,
                PROJECT_REPO_URLS
            );
            expect(result.shouldPoll).toBe(false);
        });
    });
});
