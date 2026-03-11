/**
 * GitHub Webhook Handler — processes incoming webhook events from GitHub
 * and triggers immediate PR polling for the affected project.
 *
 * Supported events:
 * - `pull_request` — PR status changes (opened, closed, reopened, synchronize, etc.)
 * - `check_run` — Individual CI check completed
 * - `check_suite` — CI check suite completed
 * - `workflow_run` — GitHub Actions workflow completed
 *
 * Signature verification uses HMAC SHA-256 (X-Hub-Signature-256 header).
 */

import crypto from "node:crypto";

// ── Signature verification ──────────────────────────────────────────────────

/**
 * Verify the HMAC SHA-256 signature of a GitHub webhook payload.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param payload Raw request body as a Buffer or string
 * @param secret The webhook secret configured for the project
 * @param signatureHeader Value of the X-Hub-Signature-256 header (e.g. "sha256=abc123...")
 * @returns true if the signature is valid
 */
export function verifyWebhookSignature(
    payload: Buffer | string,
    secret: string,
    signatureHeader: string | undefined
): boolean {
    if (!signatureHeader) return false;

    const expected =
        "sha256=" +
        crypto
            .createHmac("sha256", secret)
            .update(payload)
            .digest("hex");

    // Both buffers must be the same length for timingSafeEqual
    const sigBuffer = Buffer.from(signatureHeader);
    const expectedBuffer = Buffer.from(expected);

    if (sigBuffer.length !== expectedBuffer.length) return false;

    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
}

// ── Event types ─────────────────────────────────────────────────────────────

/** GitHub event types that we process. */
export const SUPPORTED_EVENTS = new Set([
    "pull_request",
    "check_run",
    "check_suite",
    "workflow_run"
]);

/**
 * PR event actions that indicate a meaningful state change worth triggering
 * an immediate poll. Other actions (labeled, assigned, etc.) are ignored.
 */
const PR_RELEVANT_ACTIONS = new Set([
    "opened",
    "closed",
    "reopened",
    "synchronize",
    "ready_for_review",
    "converted_to_draft"
]);

/**
 * Check run / check suite actions that indicate completion.
 */
const CHECK_RELEVANT_ACTIONS = new Set(["completed"]);

/**
 * Workflow run actions that indicate completion or progress.
 */
const WORKFLOW_RELEVANT_ACTIONS = new Set(["completed"]);

// ── Payload types (minimal — only fields we actually use) ───────────────────

export interface WebhookRepository {
    full_name: string;
    html_url: string;
}

export interface WebhookPayload {
    action?: string;
    repository?: WebhookRepository;
    [key: string]: unknown;
}

// ── Event filtering ─────────────────────────────────────────────────────────

export interface WebhookFilterResult {
    /** Whether this event should trigger a poll. */
    shouldPoll: boolean;
    /** Human-readable reason for accepting or rejecting the event. */
    reason: string;
}

/**
 * Determine whether a webhook event should trigger an immediate poll.
 *
 * @param event The X-GitHub-Event header value
 * @param payload Parsed JSON payload
 * @param projectRepoUrls List of repository URLs configured for the project
 */
export function shouldTriggerPoll(
    event: string,
    payload: WebhookPayload,
    projectRepoUrls: string[]
): WebhookFilterResult {
    // 1. Check if the event type is one we care about
    if (!SUPPORTED_EVENTS.has(event)) {
        return { shouldPoll: false, reason: `Unsupported event type: ${event}` };
    }

    // 2. Verify the repository belongs to this project
    const repoFullName = payload.repository?.full_name;
    const repoHtmlUrl = payload.repository?.html_url;

    if (!repoFullName && !repoHtmlUrl) {
        return {
            shouldPoll: false,
            reason: "No repository information in payload"
        };
    }

    const repoMatches = projectRepoUrls.some((url) => {
        // Normalize: remove trailing .git and compare
        const normalized = url.replace(/\.git$/, "").toLowerCase();
        return (
            (repoHtmlUrl && normalized === repoHtmlUrl.toLowerCase()) ||
            (repoFullName && normalized.endsWith(`/${repoFullName.toLowerCase()}`))
        );
    });

    if (!repoMatches) {
        return {
            shouldPoll: false,
            reason: `Repository ${repoFullName ?? repoHtmlUrl} not configured for this project`
        };
    }

    // 3. Check if the action is relevant for the event type
    const action = payload.action;

    switch (event) {
        case "pull_request":
            if (!action || !PR_RELEVANT_ACTIONS.has(action)) {
                return {
                    shouldPoll: false,
                    reason: `pull_request action "${action}" is not a relevant state change`
                };
            }
            return {
                shouldPoll: true,
                reason: `pull_request ${action}`
            };

        case "check_run":
            if (!action || !CHECK_RELEVANT_ACTIONS.has(action)) {
                return {
                    shouldPoll: false,
                    reason: `check_run action "${action}" is not relevant`
                };
            }
            return {
                shouldPoll: true,
                reason: `check_run ${action}`
            };

        case "check_suite":
            if (!action || !CHECK_RELEVANT_ACTIONS.has(action)) {
                return {
                    shouldPoll: false,
                    reason: `check_suite action "${action}" is not relevant`
                };
            }
            return {
                shouldPoll: true,
                reason: `check_suite ${action}`
            };

        case "workflow_run":
            if (!action || !WORKFLOW_RELEVANT_ACTIONS.has(action)) {
                return {
                    shouldPoll: false,
                    reason: `workflow_run action "${action}" is not relevant`
                };
            }
            return {
                shouldPoll: true,
                reason: `workflow_run ${action}`
            };

        default:
            return { shouldPoll: false, reason: `Unhandled event: ${event}` };
    }
}
