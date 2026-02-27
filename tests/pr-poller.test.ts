import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrPoller, normalizeGhState, type TaskAccessor, type GhQueryFn } from "../src/pr-poller.js";
import type { PullRequestState, Task } from "../src/types.js";
import type { Config } from "../src/config/config.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        taskId: "task1234" as Task["taskId"],
        projectId: "proj" as Task["projectId"],
        chainId: "chain111" as Task["chainId"],
        branch: "impl/task1234",
        prompt: "Do something",
        status: "completed",
        startedAt: "2025-01-01T00:00:00Z",
        completedAt: "2025-01-01T01:00:00Z",
        output: "",
        attempt: 1,
        ...overrides,
    };
}

function makeConfig(githubToken?: string): Config {
    return {
        server: { workspaceDir: "/tmp", maxConcurrentTasks: 3, adminPassword: "pw" },
        projects: {
            proj: {
                apiKey: "key",
                repositories: [],
                claudeCode: { command: "claude", timeoutSeconds: 3600, mcpServers: {} },
                auth: githubToken ? { githubToken } : {},
                maxConcurrentTasks: 1,
            },
        },
    } as unknown as Config;
}

function makeAccessor(tasks: Task[]): TaskAccessor & {
    updates: Array<{ taskId: string; prUrl: string; state: PullRequestState }>;
} {
    const updates: Array<{ taskId: string; prUrl: string; state: PullRequestState }> = [];
    return {
        listAllTasks: () => tasks,
        updatePrState(taskId, prUrl, state) {
            updates.push({ taskId, prUrl, state });
        },
        updates,
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
                taskId: "aaa" as Task["taskId"],
                pullRequests: [
                    { repo: "r1", url: "https://github.com/o/r1/pull/1", state: "open" },
                ],
            }),
            makeTask({
                taskId: "bbb" as Task["taskId"],
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
});
