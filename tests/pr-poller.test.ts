import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    PrPoller,
    normalizeGhState,
    analyzePipelineChecks,
    type TaskAccessor,
    type GhQueryFn,
    type GhChecksQueryFn,
    type GhCheckRun,
    type PollableTask
} from "../src/pr-poller.js";
import type { PullRequestState } from "../src/types.js";
import type { Config } from "../src/config/config.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<PollableTask> = {}): PollableTask {
    return {
        taskId: "task1234",
        projectId: "proj",
        status: "completed",
        ...overrides,
    };
}

function makeConfig(githubToken?: string, pipelineNames?: string[], timeoutHours?: number): Config {
    return {
        server: { workspaceDir: "/tmp", maxConcurrentTasks: 3, adminPassword: "pw", metaCpus: 0.4, sandboxCpus: 0.4 },
        projects: {
            proj: {
                data: {
                    apiKey: "key",
                    repositories: [],
                    claudeCode: { command: "claude", timeoutSeconds: 3600, mcpServers: {} },
                    auth: githubToken ? { githubToken } : {},
                    maxConcurrentTasks: 1,
                    handlePipelines: pipelineNames
                        ? { pipelines: pipelineNames, retryCount: 1, timeoutHours: timeoutHours ?? 8 }
                        : undefined,
                },
            },
        },
    } as unknown as Config;
}

function makeAccessor(tasks: PollableTask[]): TaskAccessor & {
    updates: Array<{ taskId: string; prUrl: string; state: PullRequestState }>;
    pipelineCompleted: string[];
    pipelineFailures: Array<{ taskId: string; error: string }>;
} {
    const updates: Array<{ taskId: string; prUrl: string; state: PullRequestState }> = [];
    const pipelineCompleted: string[] = [];
    const pipelineFailures: Array<{ taskId: string; error: string }> = [];
    return {
        listAllTasks: () => tasks,
        updatePrState(taskId, prUrl, state) {
            updates.push({ taskId, prUrl, state });
        },
        completePipelineTask(taskId) {
            pipelineCompleted.push(taskId);
        },
        handlePipelineFailure(taskId, error) {
            pipelineFailures.push({ taskId, error });
        },
        updates,
        pipelineCompleted,
        pipelineFailures,
    };
}

/** Creates a GhQueryFn that always returns the given state/isDraft values. */
function fakeQuery(state: "OPEN" | "CLOSED" | "MERGED", isDraft = false): GhQueryFn {
    return async () => ({ state, isDraft });
}

/** Creates a GhQueryFn that always rejects with an error. */
function failingQuery(message = "gh: command not found"): GhQueryFn {
    return async () => { throw new Error(message); };
}

/** Creates a GhChecksQueryFn that always returns the given checks. */
function fakeChecksQuery(checks: GhCheckRun[]): GhChecksQueryFn {
    return async () => checks;
}

/** Creates a GhChecksQueryFn that always rejects with an error. */
function failingChecksQuery(message = "gh: command not found"): GhChecksQueryFn {
    return async () => { throw new Error(message); };
}

// ── normalizeGhState ──────────────────────────────────────────────────────────

describe("normalizeGhState", () => {
    it("maps OPEN + !isDraft to open", () => {
        expect(normalizeGhState({ state: "OPEN", isDraft: false })).toBe("open");
    });

    it("maps OPEN + isDraft to draft", () => {
        expect(normalizeGhState({ state: "OPEN", isDraft: true })).toBe("draft");
    });

    it("maps CLOSED to closed", () => {
        expect(normalizeGhState({ state: "CLOSED", isDraft: false })).toBe("closed");
    });

    it("maps MERGED to merged", () => {
        expect(normalizeGhState({ state: "MERGED", isDraft: false })).toBe("merged");
    });
});

// ── analyzePipelineChecks ─────────────────────────────────────────────────────

describe("analyzePipelineChecks", () => {
    it("returns passing when no checks are present (no CI configured)", () => {
        expect(analyzePipelineChecks([])).toEqual({ status: "passing" });
    });

    it("returns passing when all checks are SUCCESS", () => {
        const checks: GhCheckRun[] = [
            { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
            { name: "lint", state: "SUCCESS", conclusion: "SUCCESS" },
        ];
        expect(analyzePipelineChecks(checks)).toEqual({ status: "passing" });
    });

    it("returns passing for NEUTRAL, SKIPPED and CANCELLED checks", () => {
        const checks: GhCheckRun[] = [
            { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
            { name: "optional", state: "NEUTRAL", conclusion: "NEUTRAL" },
            { name: "skipped", state: "SKIPPED", conclusion: "SKIPPED" },
            { name: "superseded", state: "CANCELLED", conclusion: "CANCELLED" },
        ];
        expect(analyzePipelineChecks(checks)).toEqual({ status: "passing" });
    });

    it("returns failing when any check is FAILURE", () => {
        const checks: GhCheckRun[] = [
            { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
            { name: "test", state: "FAILURE", conclusion: "FAILURE" },
        ];
        const result = analyzePipelineChecks(checks);
        expect(result.status).toBe("failing");
        expect(result.failedCheck).toBe("test");
    });

    it("returns failing when a check is TIMED_OUT", () => {
        const checks: GhCheckRun[] = [
            { name: "slow-test", state: "TIMED_OUT", conclusion: "TIMED_OUT" },
        ];
        const result = analyzePipelineChecks(checks);
        expect(result.status).toBe("failing");
        expect(result.failedCheck).toBe("slow-test");
    });

    it("returns failing when a check is ACTION_REQUIRED", () => {
        const checks: GhCheckRun[] = [
            { name: "review", state: "ACTION_REQUIRED", conclusion: "ACTION_REQUIRED" },
        ];
        const result = analyzePipelineChecks(checks);
        expect(result.status).toBe("failing");
        expect(result.failedCheck).toBe("review");
    });

    it("returns failing for ERROR state", () => {
        const checks: GhCheckRun[] = [
            { name: "deploy", state: "ERROR", conclusion: "" },
        ];
        const result = analyzePipelineChecks(checks);
        expect(result.status).toBe("failing");
    });

    it("returns passing for CANCELLED state (auto-cancelled by GitHub concurrency)", () => {
        // GitHub auto-cancels jobs when a newer run supersedes the current one.
        // This is not a code defect, so we treat it as passing (like SKIPPED).
        const checks: GhCheckRun[] = [
            { name: "ci", state: "CANCELLED", conclusion: "CANCELLED" },
        ];
        const result = analyzePipelineChecks(checks);
        expect(result.status).toBe("passing");
    });

    it("returns passing when state is PENDING but conclusion is CANCELLED (queued job in cancelled run)", () => {
        // When a GitHub workflow run is auto-cancelled, jobs that were still
        // QUEUED (never started) may have state="PENDING" from the QUEUED status
        // but conclusion="CANCELLED" once the run is cancelled. We must use the
        // conclusion in this case, not the stale PENDING state.
        const checks: GhCheckRun[] = [
            { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
            { name: "deploy", state: "PENDING", conclusion: "CANCELLED" },
        ];
        const result = analyzePipelineChecks(checks);
        expect(result.status).toBe("passing");
    });

    it("returns passing for STALE state (outdated check superseded by newer commit)", () => {
        // GitHub marks a check run as STALE when the PR's commit was updated and
        // the old check run is no longer relevant. A stale check is terminal —
        // it will never complete — so waiting for it would block the task forever.
        // Treat it as neutral (passing), the same as SKIPPED or CANCELLED.
        const checks: GhCheckRun[] = [
            { name: "ci", state: "STALE", conclusion: "" },
        ];
        const result = analyzePipelineChecks(checks);
        expect(result.status).toBe("passing");
    });

    it("completes task when all current checks pass and old check is STALE", () => {
        // Reproduces: task stuck in waiting_for_pipeline when all important
        // checks pass but there is also a STALE check from a previous commit.
        const checks: GhCheckRun[] = [
            { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
            { name: "test", state: "SUCCESS", conclusion: "SUCCESS" },
            // An outdated check run from a previous commit — STALE and never completing
            { name: "old-deploy", state: "STALE", conclusion: "" },
        ];
        expect(analyzePipelineChecks(checks)).toEqual({ status: "passing" });
    });

    it("returns pending when any check has empty state (in-progress)", () => {
        const checks: GhCheckRun[] = [
            { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
            { name: "test", state: "", conclusion: "" },
        ];
        expect(analyzePipelineChecks(checks)).toEqual({ status: "pending" });
    });

    it("returns pending when any check is PENDING", () => {
        const checks: GhCheckRun[] = [
            { name: "build", state: "PENDING", conclusion: "" },
        ];
        expect(analyzePipelineChecks(checks)).toEqual({ status: "pending" });
    });

    it("prioritizes failing over pending", () => {
        const checks: GhCheckRun[] = [
            { name: "build", state: "PENDING", conclusion: "" },
            { name: "test", state: "FAILURE", conclusion: "FAILURE" },
            { name: "lint", state: "SUCCESS", conclusion: "SUCCESS" },
        ];
        const result = analyzePipelineChecks(checks);
        // failing check comes after pending in array, but failing wins
        expect(result.status).toBe("failing");
        expect(result.failedCheck).toBe("test");
    });

    it("is case-insensitive for state values", () => {
        const checks: GhCheckRun[] = [
            { name: "build", state: "success", conclusion: "success" },
        ];
        expect(analyzePipelineChecks(checks)).toEqual({ status: "passing" });
    });

    it("returns passing for EXPECTED state (legacy required status check placeholder that never completes)", () => {
        // GitHub creates EXPECTED checks for required status contexts that
        // haven't been submitted. If no service reports, the check stays EXPECTED
        // forever. Treating it as neutral/passing prevents blocking the task indefinitely.
        const checks: GhCheckRun[] = [
            { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
            { name: "legacy-required", state: "EXPECTED", conclusion: "" },
        ];
        expect(analyzePipelineChecks(checks)).toEqual({ status: "passing" });
    });

    it("returns passing when only EXPECTED checks are present", () => {
        const checks: GhCheckRun[] = [
            { name: "status-check", state: "EXPECTED", conclusion: "" },
        ];
        expect(analyzePipelineChecks(checks)).toEqual({ status: "passing" });
    });

    it("returns passing for EXPECTED state (case-insensitive)", () => {
        const checks: GhCheckRun[] = [
            { name: "legacy", state: "expected", conclusion: "" },
        ];
        expect(analyzePipelineChecks(checks)).toEqual({ status: "passing" });
    });

    // ── Pipeline name filtering ────────────────────────────────────────────────

    it("returns passing when pipelineNames filter provided, no checks match, and all existing checks are terminal", () => {
        // All existing jobs are done but the configured pipeline names never appeared
        // → they were never triggered (likely wrong name in config). Avoid blocking forever.
        const checks: GhCheckRun[] = [
            { name: "unrelated-job", state: "SUCCESS", conclusion: "SUCCESS" },
        ];
        expect(analyzePipelineChecks(checks, ["build", "test"])).toEqual({
            status: "passing",
        });
    });

    it("returns pending when pipelineNames filter provided, no checks match, but some existing checks still in-progress", () => {
        // The watched pipeline hasn't appeared yet but another check is still running —
        // the watched job might start after the in-progress one finishes.
        const checks: GhCheckRun[] = [
            { name: "unrelated-setup", state: "PENDING", conclusion: "" },
        ];
        expect(analyzePipelineChecks(checks, ["build", "test"])).toEqual({
            status: "pending",
        });
    });

    it("returns pending when pipelineNames provided but checks array is empty", () => {
        // No checks at all — CI hasn't started yet, keep waiting.
        expect(analyzePipelineChecks([], ["build"])).toEqual({ status: "pending" });
    });

    it("returns passing (no-CI) when pipelineNames is empty array", () => {
        // Empty filter = no filtering → treat as no CI configured
        expect(analyzePipelineChecks([], [])).toEqual({ status: "passing" });
    });

    it("only evaluates checks matching pipelineNames — ignores others", () => {
        const checks: GhCheckRun[] = [
            // This unrelated failing check should be ignored
            { name: "deploy", state: "FAILURE", conclusion: "FAILURE" },
            // The watched check passes
            { name: "test", state: "SUCCESS", conclusion: "SUCCESS" },
        ];
        // Only watching "test" — "deploy" failure should not affect result
        expect(analyzePipelineChecks(checks, ["test"])).toEqual({ status: "passing" });
    });

    it("returns failing when a watched pipeline check fails, even if others pass", () => {
        const checks: GhCheckRun[] = [
            { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
            { name: "test", state: "FAILURE", conclusion: "FAILURE" },
            { name: "lint", state: "SUCCESS", conclusion: "SUCCESS" },
        ];
        const result = analyzePipelineChecks(checks, ["build", "test"]);
        expect(result.status).toBe("failing");
        expect(result.failedCheck).toBe("test");
    });

    it("returns pending when some watched pipeline checks are still running", () => {
        const checks: GhCheckRun[] = [
            { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
            { name: "test", state: "PENDING", conclusion: "" },
        ];
        expect(analyzePipelineChecks(checks, ["build", "test"])).toEqual({
            status: "pending",
        });
    });

    it("returns passing when all watched pipeline checks pass (others ignored)", () => {
        const checks: GhCheckRun[] = [
            { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
            { name: "test", state: "SUCCESS", conclusion: "SUCCESS" },
            // An unrelated check still running — should be ignored
            { name: "e2e", state: "PENDING", conclusion: "" },
        ];
        expect(analyzePipelineChecks(checks, ["build", "test"])).toEqual({
            status: "passing",
        });
    });
});

// ── PrPoller.pollAll ──────────────────────────────────────────────────────────

describe("PrPoller", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("skips tasks with no pull requests", async () => {
        const task = makeTask({ pullRequests: undefined });
        const accessor = makeAccessor([task]);
        const poller = new PrPoller(accessor, makeConfig(), 60_000, failingQuery());

        await poller.pollAll();

        expect(accessor.updates).toHaveLength(0);
    });

    it("skips PRs in terminal states (merged, closed)", async () => {
        const task = makeTask({
            pullRequests: [
                { repo: "r", url: "https://github.com/o/r/pull/1", state: "merged" },
                { repo: "r", url: "https://github.com/o/r/pull/2", state: "closed" },
            ],
        });
        const accessor = makeAccessor([task]);
        const poller = new PrPoller(accessor, makeConfig(), 60_000, failingQuery());

        await poller.pollAll();

        // Terminal states are skipped — no queries or updates
        expect(accessor.updates).toHaveLength(0);
    });

    it("calls updatePrState with 'open' state when GitHub returns OPEN non-draft", async () => {
        const task = makeTask({
            pullRequests: [
                { repo: "repo", url: "https://github.com/owner/repo/pull/42", state: "open" },
            ],
        });
        const accessor = makeAccessor([task]);
        const poller = new PrPoller(accessor, makeConfig("gh-token"), 60_000, fakeQuery("OPEN", false));

        await poller.pollAll();

        expect(accessor.updates).toHaveLength(1);
        expect(accessor.updates[0]).toMatchObject({
            taskId: "task1234",
            prUrl: "https://github.com/owner/repo/pull/42",
            state: "open",
        });
    });

    it("calls updatePrState with 'draft' state when GitHub returns OPEN + isDraft", async () => {
        const task = makeTask({
            pullRequests: [
                { repo: "repo", url: "https://github.com/owner/repo/pull/10" },
            ],
        });
        const accessor = makeAccessor([task]);
        const poller = new PrPoller(accessor, makeConfig("token"), 60_000, fakeQuery("OPEN", true));

        await poller.pollAll();

        expect(accessor.updates).toHaveLength(1);
        expect(accessor.updates[0].state).toBe("draft");
    });

    it("calls updatePrState with 'merged' state when GitHub returns MERGED", async () => {
        const task = makeTask({
            pullRequests: [
                { repo: "repo", url: "https://github.com/owner/repo/pull/7", state: "open" },
            ],
        });
        const accessor = makeAccessor([task]);
        const poller = new PrPoller(accessor, makeConfig(), 60_000, fakeQuery("MERGED"));

        await poller.pollAll();

        expect(accessor.updates).toHaveLength(1);
        expect(accessor.updates[0].state).toBe("merged");
    });

    it("calls updatePrState with 'closed' state when GitHub returns CLOSED", async () => {
        const task = makeTask({
            pullRequests: [
                { repo: "repo", url: "https://github.com/owner/repo/pull/8", state: "draft" },
            ],
        });
        const accessor = makeAccessor([task]);
        const poller = new PrPoller(accessor, makeConfig(), 60_000, fakeQuery("CLOSED"));

        await poller.pollAll();

        expect(accessor.updates).toHaveLength(1);
        expect(accessor.updates[0].state).toBe("closed");
    });

    it("polls PRs whose state is undefined (newly created, not yet checked)", async () => {
        const task = makeTask({
            pullRequests: [
                { repo: "repo", url: "https://github.com/owner/repo/pull/10" },
            ],
        });
        const accessor = makeAccessor([task]);
        const poller = new PrPoller(accessor, makeConfig("token"), 60_000, fakeQuery("OPEN", true));

        await poller.pollAll();

        expect(accessor.updates).toHaveLength(1);
        expect(accessor.updates[0].state).toBe("draft");
    });

    it("handles gh errors gracefully without throwing", async () => {
        const task = makeTask({
            pullRequests: [
                { repo: "repo", url: "https://github.com/owner/repo/pull/99", state: "open" },
            ],
        });
        const accessor = makeAccessor([task]);
        const poller = new PrPoller(accessor, makeConfig(), 60_000, failingQuery("gh: not found"));

        // Should not throw even when the query fails
        await expect(poller.pollAll()).resolves.toBeUndefined();
        // No updates should have been emitted
        expect(accessor.updates).toHaveLength(0);
    });

    it("polls multiple PRs across multiple tasks", async () => {
        const tasks = [
            makeTask({
                taskId: "aaa",
                pullRequests: [
                    { repo: "r1", url: "https://github.com/o/r1/pull/1", state: "open" },
                ],
            }),
            makeTask({
                taskId: "bbb",
                pullRequests: [
                    { repo: "r2", url: "https://github.com/o/r2/pull/2", state: "draft" },
                    { repo: "r2", url: "https://github.com/o/r2/pull/3", state: "merged" }, // skipped
                ],
            }),
        ];
        const accessor = makeAccessor(tasks);
        const poller = new PrPoller(accessor, makeConfig("token"), 60_000, fakeQuery("OPEN", false));

        await poller.pollAll();

        // 2 active PRs checked (1 from task aaa, 1 non-terminal from task bbb)
        expect(accessor.updates).toHaveLength(2);
        expect(accessor.updates.map((u) => u.prUrl)).toContain("https://github.com/o/r1/pull/1");
        expect(accessor.updates.map((u) => u.prUrl)).toContain("https://github.com/o/r2/pull/2");
    });

    it("start() creates a periodic interval", () => {
        const accessor = makeAccessor([]);
        const poller = new PrPoller(accessor, makeConfig(), 1000, fakeQuery("OPEN"));

        const setIntervalSpy = vi.spyOn(global, "setInterval");
        poller.start();
        expect(setIntervalSpy).toHaveBeenCalledOnce();
        poller.stop();
    });

    it("start() triggers an immediate pollAll() so restarted tasks are resolved without waiting a full interval", async () => {
        vi.useRealTimers();

        // Task that was waiting for pipeline when the implementer restarted.
        // All pipeline checks have since passed — the immediate poll should complete it.
        const task = makeTask({
            taskId: "restart-task",
            status: "waiting_for_pipeline",
            pullRequests: [
                { repo: "r", url: "https://github.com/o/r/pull/99", state: "open" },
            ],
        });
        const accessor = makeAccessor([task]);
        const allPassChecks: GhCheckRun[] = [
            { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
        ];
        const poller = new PrPoller(
            accessor, makeConfig("token"), 60_000,
            fakeQuery("OPEN"), 1,
            fakeChecksQuery(allPassChecks)
        );

        poller.start();
        // Wait a tick for the async immediate poll to complete
        await new Promise((r) => setTimeout(r, 10));
        poller.stop();

        // The immediate poll should have resolved the task without waiting for the interval
        expect(accessor.pipelineCompleted).toContain("restart-task");

        vi.useFakeTimers();
    });

    it("start() is idempotent (calling twice creates only one interval)", () => {
        const accessor = makeAccessor([]);
        const poller = new PrPoller(accessor, makeConfig(), 1000, fakeQuery("OPEN"));

        const setIntervalSpy = vi.spyOn(global, "setInterval");
        poller.start();
        poller.start(); // second call should be a no-op
        expect(setIntervalSpy).toHaveBeenCalledOnce();
        poller.stop();
    });

    it("stop() clears the interval", () => {
        const accessor = makeAccessor([]);
        const poller = new PrPoller(accessor, makeConfig(), 1000, fakeQuery("OPEN"));
        const clearIntervalSpy = vi.spyOn(global, "clearInterval");

        poller.start();
        poller.stop();

        expect(clearIntervalSpy).toHaveBeenCalledOnce();
    });

    // ── Sequential / concurrency behaviour ────────────────────────────────────

    it("processes PRs sequentially (default concurrency=1) — one at a time, never overlapping", async () => {
        vi.useRealTimers();

        const activeAtSameTime: number[] = [];
        let active = 0;
        let maxActive = 0;

        const trackingQuery: GhQueryFn = async () => {
            active++;
            if (active > maxActive) maxActive = active;
            await new Promise((r) => setTimeout(r, 10));
            active--;
            return { state: "OPEN", isDraft: false };
        };

        const task = makeTask({
            pullRequests: [
                { repo: "r", url: "pr-1", state: "open" },
                { repo: "r", url: "pr-2", state: "open" },
                { repo: "r", url: "pr-3", state: "open" },
            ],
        });

        const accessor = makeAccessor([task]);
        // Default concurrency = 1
        const poller = new PrPoller(accessor, makeConfig(), 60_000, trackingQuery);
        await poller.pollAll();

        // With concurrency=1 at most 1 query runs at a time
        expect(maxActive).toBe(1);
        expect(accessor.updates).toHaveLength(3);

        vi.useFakeTimers();
    });

    it("concurrency=2 checks all PRs and never exceeds the limit", async () => {
        vi.useRealTimers();

        let active = 0;
        let maxActive = 0;

        const trackingQuery: GhQueryFn = async () => {
            active++;
            if (active > maxActive) maxActive = active;
            await new Promise((r) => setTimeout(r, 20));
            active--;
            return { state: "OPEN", isDraft: false };
        };

        const task = makeTask({
            pullRequests: [
                { repo: "r", url: "pr-1", state: "open" },
                { repo: "r", url: "pr-2", state: "open" },
                { repo: "r", url: "pr-3", state: "open" },
                { repo: "r", url: "pr-4", state: "open" },
            ],
        });

        const accessor = makeAccessor([task]);
        const poller = new PrPoller(accessor, makeConfig(), 60_000, trackingQuery, 2);
        await poller.pollAll();

        expect(maxActive).toBeLessThanOrEqual(2);
        expect(accessor.updates).toHaveLength(4);

        vi.useFakeTimers();
    });

    it("error in one PR does not stop sequential processing of remaining PRs", async () => {
        const urls: string[] = [];
        let callIndex = 0;

        const partiallyFailingQuery: GhQueryFn = async (url) => {
            callIndex++;
            urls.push(url);
            if (callIndex === 2) throw new Error("transient network error");
            return { state: "OPEN", isDraft: false };
        };

        const task = makeTask({
            pullRequests: [
                { repo: "r", url: "pr-1", state: "open" },
                { repo: "r", url: "pr-2", state: "open" }, // will fail
                { repo: "r", url: "pr-3", state: "open" },
            ],
        });

        const accessor = makeAccessor([task]);
        const poller = new PrPoller(accessor, makeConfig(), 60_000, partiallyFailingQuery);
        await poller.pollAll(); // must not throw

        // All 3 PRs must have been attempted
        expect(urls).toEqual(["pr-1", "pr-2", "pr-3"]);
        // Only 2 successful updates (pr-2 failed)
        expect(accessor.updates).toHaveLength(2);
        expect(accessor.updates.map((u) => u.prUrl)).toContain("pr-1");
        expect(accessor.updates.map((u) => u.prUrl)).toContain("pr-3");
    });

    it("always calls updatePrState even when state is unchanged (refreshes lastCheckedAt)", async () => {
        const task = makeTask({
            pullRequests: [
                { repo: "r", url: "pr-stable", state: "open" },
            ],
        });
        const accessor = makeAccessor([task]);
        // query returns same state as stored
        const poller = new PrPoller(accessor, makeConfig(), 60_000, fakeQuery("OPEN", false));
        await poller.pollAll();

        // updatePrState must still be called to refresh lastCheckedAt
        expect(accessor.updates).toHaveLength(1);
        expect(accessor.updates[0].state).toBe("open");
    });

    // ── Pipeline checks for waiting_for_pipeline tasks ────────────────────────

    describe("pipeline check polling", () => {
        it("does not check pipeline for tasks not in waiting_for_pipeline status", async () => {
            const task = makeTask({
                status: "completed",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/1", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const checksQuery = vi.fn(fakeChecksQuery([]));
            const poller = new PrPoller(
                accessor, makeConfig(), 60_000, fakeQuery("OPEN"), 1, checksQuery
            );

            await poller.pollAll();

            expect(checksQuery).not.toHaveBeenCalled();
            expect(accessor.pipelineCompleted).toHaveLength(0);
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        it("completes task when all pipeline checks pass", async () => {
            const task = makeTask({
                taskId: "pipe-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/10", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const successChecks: GhCheckRun[] = [
                { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
                { name: "test", state: "SUCCESS", conclusion: "SUCCESS" },
            ];
            const poller = new PrPoller(
                accessor, makeConfig("token"), 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(successChecks)
            );

            await poller.pollAll();

            expect(accessor.pipelineCompleted).toContain("pipe-task");
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        it("completes task when no checks are configured (empty checks array)", async () => {
            const task = makeTask({
                taskId: "no-ci-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/20", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const poller = new PrPoller(
                accessor, makeConfig("token"), 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery([]) // no checks
            );

            await poller.pollAll();

            expect(accessor.pipelineCompleted).toContain("no-ci-task");
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        it("fails task when a pipeline check fails", async () => {
            const task = makeTask({
                taskId: "fail-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/30", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const failedChecks: GhCheckRun[] = [
                { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
                { name: "test", state: "FAILURE", conclusion: "FAILURE" },
            ];
            const poller = new PrPoller(
                accessor, makeConfig("token"), 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(failedChecks)
            );

            await poller.pollAll();

            expect(accessor.pipelineFailures).toHaveLength(1);
            expect(accessor.pipelineFailures[0].taskId).toBe("fail-task");
            expect(accessor.pipelineFailures[0].error).toContain("test");
            expect(accessor.pipelineCompleted).toHaveLength(0);
        });

        it("completes task when passing checks mix with CANCELLED (auto-cancelled by GitHub)", async () => {
            // Reproduces: task stuck in waiting_for_pipeline when all important
            // pipelines pass but one is auto-cancelled (e.g. by GitHub's concurrency
            // group cancelling a superseded run).
            const task = makeTask({
                taskId: "cancelled-check-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/35", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const mixedChecks: GhCheckRun[] = [
                { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
                { name: "test", state: "SUCCESS", conclusion: "SUCCESS" },
                // auto-cancelled by GitHub concurrency / fail-fast
                { name: "deploy", state: "CANCELLED", conclusion: "CANCELLED" },
            ];
            const poller = new PrPoller(
                accessor, makeConfig("token"), 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(mixedChecks)
            );

            await poller.pollAll();

            // Task should complete — CANCELLED is treated as neutral, not a failure
            expect(accessor.pipelineCompleted).toContain("cancelled-check-task");
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        it("completes task when a queued job shows PENDING state but CANCELLED conclusion", async () => {
            // When a workflow run is auto-cancelled, jobs that were QUEUED (never
            // started) may appear with state="PENDING" (from the QUEUED status) but
            // conclusion="CANCELLED". Without checking the conclusion, the poller
            // would wait forever for a check that will never change state.
            const task = makeTask({
                taskId: "queued-cancelled-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/36", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const mixedChecks: GhCheckRun[] = [
                { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
                // QUEUED job in a cancelled run: state stays PENDING but conclusion is set
                { name: "optional-job", state: "PENDING", conclusion: "CANCELLED" },
            ];
            const poller = new PrPoller(
                accessor, makeConfig("token"), 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(mixedChecks)
            );

            await poller.pollAll();

            expect(accessor.pipelineCompleted).toContain("queued-cancelled-task");
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        it("completes task when all current checks pass and old check is STALE", async () => {
            // Reproduces: task stuck in waiting_for_pipeline when pipelines have
            // all finished but an old check run from a previous commit is STALE.
            // A STALE check is terminal — it will never complete — so treating it
            // as pending would block the task forever.
            const task = makeTask({
                taskId: "stale-check-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/37", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const checksWithStale: GhCheckRun[] = [
                { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
                { name: "test", state: "SUCCESS", conclusion: "SUCCESS" },
                // Outdated check from a previous commit — STALE with empty conclusion
                { name: "old-ci", state: "STALE", conclusion: "" },
            ];
            const poller = new PrPoller(
                accessor, makeConfig("token"), 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(checksWithStale)
            );

            await poller.pollAll();

            // Task should complete — STALE is treated as neutral, not pending
            expect(accessor.pipelineCompleted).toContain("stale-check-task");
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        it("keeps waiting when pipeline checks are still pending", async () => {
            const task = makeTask({
                taskId: "pending-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/40", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const pendingChecks: GhCheckRun[] = [
                { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
                { name: "test", state: "PENDING", conclusion: "" },
            ];
            const poller = new PrPoller(
                accessor, makeConfig("token"), 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(pendingChecks)
            );

            await poller.pollAll();

            expect(accessor.pipelineCompleted).toHaveLength(0);
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        it("keeps waiting and does not fail if checks query throws (transient error)", async () => {
            const task = makeTask({
                taskId: "error-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/50", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const poller = new PrPoller(
                accessor, makeConfig("token"), 60_000,
                fakeQuery("OPEN"), 1,
                failingChecksQuery("network error")
            );

            // Should not throw
            await expect(poller.pollAll()).resolves.toBeUndefined();

            // Should not complete or fail the task on transient error
            expect(accessor.pipelineCompleted).toHaveLength(0);
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        it("checks pipeline for all PRs on a task — fails if any PR has a failing check", async () => {
            const task = makeTask({
                taskId: "multi-pr-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r1", url: "https://github.com/o/r1/pull/1", state: "open" },
                    { repo: "r2", url: "https://github.com/o/r2/pull/2", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);

            let callCount = 0;
            const mixedChecksQuery: GhChecksQueryFn = async () => {
                callCount++;
                if (callCount === 1) {
                    return [{ name: "build", state: "SUCCESS", conclusion: "SUCCESS" }];
                }
                return [{ name: "test", state: "FAILURE", conclusion: "FAILURE" }];
            };

            const poller = new PrPoller(
                accessor, makeConfig("token"), 60_000,
                fakeQuery("OPEN"), 1,
                mixedChecksQuery
            );

            await poller.pollAll();

            expect(accessor.pipelineFailures).toHaveLength(1);
            expect(accessor.pipelineFailures[0].taskId).toBe("multi-pr-task");
        });

        it("skips merged/closed PRs when checking pipeline status", async () => {
            const task = makeTask({
                taskId: "merged-pr-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    // merged PR — should be skipped for pipeline check
                    { repo: "r", url: "https://github.com/o/r/pull/1", state: "merged" },
                ],
            });
            const accessor = makeAccessor([task]);
            const checksQuery = vi.fn(fakeChecksQuery([]));
            const poller = new PrPoller(
                accessor, makeConfig("token"), 60_000,
                fakeQuery("MERGED"), 1,
                checksQuery
            );

            await poller.pollAll();

            // All PRs are merged/closed — skips pipeline check → task completed with no pending PRs
            expect(checksQuery).not.toHaveBeenCalled();
            // With no non-terminal PRs to check, overallStatus stays "passing" → task completed
            expect(accessor.pipelineCompleted).toContain("merged-pr-task");
        });

        it("handles multiple waiting_for_pipeline tasks independently", async () => {
            const tasks = [
                makeTask({
                    taskId: "task-pass",
                    status: "waiting_for_pipeline",
                    pullRequests: [
                        { repo: "r", url: "https://github.com/o/r/pull/1", state: "open" },
                    ],
                }),
                makeTask({
                    taskId: "task-fail",
                    status: "waiting_for_pipeline",
                    pullRequests: [
                        { repo: "r", url: "https://github.com/o/r/pull/2", state: "open" },
                    ],
                }),
            ];
            const accessor = makeAccessor(tasks);

            let callCount = 0;
            const mixedChecksQuery: GhChecksQueryFn = async () => {
                callCount++;
                if (callCount === 1) {
                    return [{ name: "build", state: "SUCCESS", conclusion: "SUCCESS" }];
                }
                return [{ name: "test", state: "FAILURE", conclusion: "FAILURE" }];
            };

            const poller = new PrPoller(
                accessor, makeConfig("token"), 60_000,
                fakeQuery("OPEN"), 1,
                mixedChecksQuery
            );

            await poller.pollAll();

            expect(accessor.pipelineCompleted).toContain("task-pass");
            expect(accessor.pipelineFailures.map((f) => f.taskId)).toContain("task-fail");
        });

        // ── handlePipelines name filtering in the poller ───────────────────────

        it("completes task when watched pipeline jobs never appeared but all other checks are done (non-existent pipeline name)", async () => {
            // The configured pipeline names don't exist in the repo's workflow.
            // Once all other checks finish, we should complete instead of blocking forever.
            const task = makeTask({
                taskId: "filter-nonexistent-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/60", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            // Config: only watching "build" and "test" — but these don't exist in the repo
            const configWithPipelines = makeConfig("token", ["build", "test"]);
            const checks: GhCheckRun[] = [
                // Only an unrelated job ran; "build" and "test" were never triggered
                { name: "unrelated", state: "SUCCESS", conclusion: "SUCCESS" },
            ];
            const poller = new PrPoller(
                accessor, configWithPipelines, 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(checks)
            );

            await poller.pollAll();

            // All existing checks done and configured pipelines never appeared → complete
            expect(accessor.pipelineCompleted).toContain("filter-nonexistent-task");
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        it("keeps waiting when watched pipeline jobs have not appeared yet but other checks still in-progress", async () => {
            // Another check is still running — the watched pipeline might start after it.
            const task = makeTask({
                taskId: "filter-pending-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/61", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const configWithPipelines = makeConfig("token", ["build", "test"]);
            const checks: GhCheckRun[] = [
                // A prerequisite job is still running
                { name: "setup", state: "PENDING", conclusion: "" },
            ];
            const poller = new PrPoller(
                accessor, configWithPipelines, 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(checks)
            );

            await poller.pollAll();

            // Some checks still pending — keep waiting
            expect(accessor.pipelineCompleted).toHaveLength(0);
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        it("completes task when all watched pipeline jobs pass (unrelated jobs ignored)", async () => {
            const task = makeTask({
                taskId: "filter-pass-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/70", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const configWithPipelines = makeConfig("token", ["build", "test"]);
            const checks: GhCheckRun[] = [
                { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
                { name: "test", state: "SUCCESS", conclusion: "SUCCESS" },
                // Unrelated still pending — should be ignored
                { name: "e2e", state: "PENDING", conclusion: "" },
            ];
            const poller = new PrPoller(
                accessor, configWithPipelines, 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(checks)
            );

            await poller.pollAll();

            expect(accessor.pipelineCompleted).toContain("filter-pass-task");
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        it("calls handlePipelineFailure when a watched pipeline job fails", async () => {
            const task = makeTask({
                taskId: "filter-fail-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/80", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const configWithPipelines = makeConfig("token", ["build", "test"]);
            const checks: GhCheckRun[] = [
                { name: "build", state: "FAILURE", conclusion: "FAILURE" },
                { name: "test", state: "SUCCESS", conclusion: "SUCCESS" },
            ];
            const poller = new PrPoller(
                accessor, configWithPipelines, 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(checks)
            );

            await poller.pollAll();

            expect(accessor.pipelineFailures).toHaveLength(1);
            expect(accessor.pipelineFailures[0].taskId).toBe("filter-fail-task");
            expect(accessor.pipelineFailures[0].error).toContain("build");
            expect(accessor.pipelineCompleted).toHaveLength(0);
        });

        it("ignores failures in unwatched jobs when handlePipelines filter is set", async () => {
            const task = makeTask({
                taskId: "ignore-unrelated-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/90", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            // Only watching "test" — "deploy" failure should be ignored
            const configWithPipelines = makeConfig("token", ["test"]);
            const checks: GhCheckRun[] = [
                { name: "test", state: "SUCCESS", conclusion: "SUCCESS" },
                { name: "deploy", state: "FAILURE", conclusion: "FAILURE" },
            ];
            const poller = new PrPoller(
                accessor, configWithPipelines, 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(checks)
            );

            await poller.pollAll();

            // "deploy" failure is not in watched pipelines — should complete
            expect(accessor.pipelineCompleted).toContain("ignore-unrelated-task");
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        it("completes task when EXPECTED check is present (legacy required status check never submitted)", async () => {
            // Reproduces: task stuck in waiting_for_pipeline when GitHub has an
            // "EXPECTED" legacy required status check that a service never submits.
            // These checks stay EXPECTED forever — treating them as pending blocks the task.
            const task = makeTask({
                taskId: "expected-check-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/100", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const checksWithExpected: GhCheckRun[] = [
                { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
                { name: "test", state: "SUCCESS", conclusion: "SUCCESS" },
                // Legacy required status check that was never submitted
                { name: "legacy-ci", state: "EXPECTED", conclusion: "" },
            ];
            const poller = new PrPoller(
                accessor, makeConfig("token"), 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(checksWithExpected)
            );

            await poller.pollAll();

            // EXPECTED is treated as neutral/passing — task should complete
            expect(accessor.pipelineCompleted).toContain("expected-check-task");
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        // ── Pipeline timeout safety net ────────────────────────────────────────

        it("auto-completes task that has been stuck in waiting_for_pipeline beyond configured timeout", async () => {
            // Simulate a task that entered waiting_for_pipeline 9 hours ago (timeout: 8h)
            const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
            const task = makeTask({
                taskId: "timeout-task",
                status: "waiting_for_pipeline",
                pipelineWaitingSince: nineHoursAgo,
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/110", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            // Config with 8h timeout (default) — task has been waiting 9h → should auto-complete
            const configWithTimeout = makeConfig("token", ["build"], 8);
            const checksQuery = vi.fn(fakeChecksQuery([
                // Still pending — would normally keep waiting
                { name: "build", state: "PENDING", conclusion: "" },
            ]));
            const poller = new PrPoller(
                accessor, configWithTimeout, 60_000,
                fakeQuery("OPEN"), 1,
                checksQuery
            );

            await poller.pollAll();

            // Timeout expired — task should be auto-completed without checking pipeline
            expect(accessor.pipelineCompleted).toContain("timeout-task");
            expect(accessor.pipelineFailures).toHaveLength(0);
            // checksQuery should NOT have been called (timeout fires before pipeline check)
            expect(checksQuery).not.toHaveBeenCalled();
        });

        it("does not auto-complete task that is within the timeout window", async () => {
            // Task that entered waiting_for_pipeline 1 hour ago (timeout: 8h) — still within window
            const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
            const task = makeTask({
                taskId: "within-timeout-task",
                status: "waiting_for_pipeline",
                pipelineWaitingSince: oneHourAgo,
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/111", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const configWithTimeout = makeConfig("token", ["build"], 8);
            const pendingChecks: GhCheckRun[] = [
                { name: "build", state: "PENDING", conclusion: "" },
            ];
            const poller = new PrPoller(
                accessor, configWithTimeout, 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(pendingChecks)
            );

            await poller.pollAll();

            // Within timeout — should keep waiting
            expect(accessor.pipelineCompleted).toHaveLength(0);
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        it("does not auto-complete when timeoutHours is 0 (timeout disabled)", async () => {
            // timeoutHours=0 disables the safety net entirely
            const longAgo = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
            const task = makeTask({
                taskId: "no-timeout-task",
                status: "waiting_for_pipeline",
                pipelineWaitingSince: longAgo,
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/112", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const configWithZeroTimeout = makeConfig("token", ["build"], 0);
            const pendingChecks: GhCheckRun[] = [
                { name: "build", state: "PENDING", conclusion: "" },
            ];
            const poller = new PrPoller(
                accessor, configWithZeroTimeout, 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(pendingChecks)
            );

            await poller.pollAll();

            // Timeout disabled (0) — should keep waiting even after 100 hours
            expect(accessor.pipelineCompleted).toHaveLength(0);
            expect(accessor.pipelineFailures).toHaveLength(0);
        });

        it("does not auto-complete when pipelineWaitingSince is not set", async () => {
            // Task in waiting_for_pipeline but pipelineWaitingSince was not recorded
            // (e.g. tasks created before the field was added) — timeout should not fire
            const task = makeTask({
                taskId: "no-since-task",
                status: "waiting_for_pipeline",
                pipelineWaitingSince: undefined,
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/113", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            const configWithTimeout = makeConfig("token", ["build"], 8);
            const pendingChecks: GhCheckRun[] = [
                { name: "build", state: "PENDING", conclusion: "" },
            ];
            const poller = new PrPoller(
                accessor, configWithTimeout, 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(pendingChecks)
            );

            await poller.pollAll();

            // No pipelineWaitingSince → timeout cannot fire → keep waiting
            expect(accessor.pipelineCompleted).toHaveLength(0);
            expect(accessor.pipelineFailures).toHaveLength(0);
        });
    });
});

// ── pollProject (webhook-triggered polling) ─────────────────────────────────

describe("PrPoller.pollProject", () => {
    it("only polls tasks for the specified project", async () => {
        const projATask = makeTask({
            taskId: "taskA",
            projectId: "projA",
            pullRequests: [{ repo: "repoA", url: "https://github.com/org/repoA/pull/1", state: "open" }],
        });
        const projBTask = makeTask({
            taskId: "taskB",
            projectId: "projB",
            pullRequests: [{ repo: "repoB", url: "https://github.com/org/repoB/pull/2", state: "open" }],
        });
        const accessor = makeAccessor([projATask, projBTask]);
        const queryFn = fakeQuery("OPEN");
        const config = {
            server: { workspaceDir: "/tmp", maxConcurrentTasks: 3, adminPassword: "pw", metaCpus: 0.4, sandboxCpus: 0.4 },
            projects: {
                projA: {
                    data: {
                        apiKey: "keyA",
                        repositories: [],
                        claudeCode: { command: "claude", timeoutSeconds: 3600, mcpServers: {} },
                        auth: { githubToken: "tokenA" },
                    },
                },
                projB: {
                    data: {
                        apiKey: "keyB",
                        repositories: [],
                        claudeCode: { command: "claude", timeoutSeconds: 3600, mcpServers: {} },
                        auth: { githubToken: "tokenB" },
                    },
                },
            },
        } as unknown as Config;

        const poller = new PrPoller(accessor, config, 60_000, queryFn);
        await poller.pollProject("projA");

        // Only projA's PR should be updated
        expect(accessor.updates).toHaveLength(1);
        expect(accessor.updates[0].taskId).toBe("taskA");
        expect(accessor.updates[0].prUrl).toBe("https://github.com/org/repoA/pull/1");
    });

    it("checks pipeline for waiting_for_pipeline tasks in the project", async () => {
        const task = makeTask({
            taskId: "taskPipe",
            projectId: "proj",
            status: "waiting_for_pipeline",
            pullRequests: [{ repo: "repo", url: "https://github.com/org/repo/pull/5", state: "open" }],
            pipelineWaitingSince: new Date(Date.now() - 60_000).toISOString(),
        });
        const accessor = makeAccessor([task]);
        const passingChecks: GhCheckRun[] = [
            { name: "build", state: "SUCCESS" },
        ];
        const config = makeConfig("token", ["build"]);
        const poller = new PrPoller(
            accessor, config, 60_000,
            fakeQuery("OPEN"), 1,
            fakeChecksQuery(passingChecks)
        );

        await poller.pollProject("proj");

        expect(accessor.pipelineCompleted).toContain("taskPipe");
    });

    it("does nothing when project has no pollable tasks", async () => {
        const accessor = makeAccessor([]);
        const queryFn = vi.fn().mockResolvedValue({ state: "OPEN", isDraft: false });
        const config = makeConfig("token");
        const poller = new PrPoller(accessor, config, 60_000, queryFn as GhQueryFn);

        await poller.pollProject("proj");

        expect(queryFn).not.toHaveBeenCalled();
        expect(accessor.updates).toHaveLength(0);
    });

    it("skips terminal PR states (merged/closed)", async () => {
        const task = makeTask({
            taskId: "taskTerm",
            projectId: "proj",
            pullRequests: [
                { repo: "repo", url: "https://github.com/org/repo/pull/10", state: "merged" },
                { repo: "repo", url: "https://github.com/org/repo/pull/11", state: "closed" },
            ],
        });
        const accessor = makeAccessor([task]);
        const queryFn = vi.fn().mockResolvedValue({ state: "OPEN", isDraft: false });
        const config = makeConfig("token");
        const poller = new PrPoller(accessor, config, 60_000, queryFn as GhQueryFn);

        await poller.pollProject("proj");

        expect(queryFn).not.toHaveBeenCalled();
        expect(accessor.updates).toHaveLength(0);
    });

    it("deduplicates concurrent pollProject calls for the same project", async () => {
        const task = makeTask({
            taskId: "taskDedup",
            projectId: "proj",
            pullRequests: [{ repo: "repo", url: "https://github.com/org/repo/pull/20", state: "open" }],
        });
        const accessor = makeAccessor([task]);

        let queryCallCount = 0;
        const slowQuery: GhQueryFn = async () => {
            queryCallCount++;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { state: "OPEN", isDraft: false };
        };

        const config = makeConfig("token");
        const poller = new PrPoller(accessor, config, 60_000, slowQuery);

        // Fire two polls simultaneously
        const [p1, p2] = [poller.pollProject("proj"), poller.pollProject("proj")];
        await Promise.all([p1, p2]);

        // Only one should actually execute the query
        expect(queryCallCount).toBe(1);
    });
});
