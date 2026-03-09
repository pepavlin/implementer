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

function makeConfig(githubToken?: string, pipelineNames?: string[]): Config {
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
                        ? { pipelines: pipelineNames, retryCount: 1 }
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

    it("returns passing for NEUTRAL and SKIPPED checks", () => {
        const checks: GhCheckRun[] = [
            { name: "build", state: "SUCCESS", conclusion: "SUCCESS" },
            { name: "optional", state: "NEUTRAL", conclusion: "NEUTRAL" },
            { name: "skipped", state: "SKIPPED", conclusion: "SKIPPED" },
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

    it("returns failing for CANCELLED state", () => {
        const checks: GhCheckRun[] = [
            { name: "ci", state: "CANCELLED", conclusion: "CANCELLED" },
        ];
        const result = analyzePipelineChecks(checks);
        expect(result.status).toBe("failing");
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

    // ── Pipeline name filtering ────────────────────────────────────────────────

    it("returns pending when pipelineNames filter provided but no checks match yet", () => {
        const checks: GhCheckRun[] = [
            { name: "unrelated-job", state: "SUCCESS", conclusion: "SUCCESS" },
        ];
        expect(analyzePipelineChecks(checks, ["build", "test"])).toEqual({
            status: "pending",
        });
    });

    it("returns pending when pipelineNames provided but checks array is empty", () => {
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

        it("keeps waiting when watched pipeline jobs have not appeared yet (pending filter)", async () => {
            const task = makeTask({
                taskId: "filter-pending-task",
                status: "waiting_for_pipeline",
                pullRequests: [
                    { repo: "r", url: "https://github.com/o/r/pull/60", state: "open" },
                ],
            });
            const accessor = makeAccessor([task]);
            // Config: only watching "build" and "test"
            const configWithPipelines = makeConfig("token", ["build", "test"]);
            const checks: GhCheckRun[] = [
                // Only an unrelated job has run so far
                { name: "unrelated", state: "SUCCESS", conclusion: "SUCCESS" },
            ];
            const poller = new PrPoller(
                accessor, configWithPipelines, 60_000,
                fakeQuery("OPEN"), 1,
                fakeChecksQuery(checks)
            );

            await poller.pollAll();

            // None of the watched jobs appeared yet — should keep waiting
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
    });
});
