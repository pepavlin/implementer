/**
 * PrPoller — background service that periodically checks the status of open
 * pull requests on GitHub and updates the stored state on tasks.
 *
 * Only pull requests whose state is "open", "draft", or not yet set are
 * polled. Merged and closed PRs are terminal states and never change.
 *
 * Uses the `gh` CLI (same as git-manager) with the project's GitHub token.
 */

import { execFile } from "node:child_process";
import type { Config } from "./config/config.js";
import type { ProjectId, PullRequest, PullRequestState, Task } from "./types.js";

/** Default polling interval: 5 minutes. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** Payload of a single GitHub PR state query. */
interface GhPrState {
    state: "OPEN" | "CLOSED" | "MERGED";
    isDraft: boolean;
}

function ghQuery(url: string, token?: string): Promise<GhPrState> {
    return new Promise((resolve, reject) => {
        const env = token ? { ...process.env, GH_TOKEN: token } : undefined;
        execFile(
            "gh",
            ["pr", "view", url, "--json", "state,isDraft"],
            { env, maxBuffer: 1024 * 1024 },
            (error, stdout) => {
                if (error) {
                    reject(new Error(`gh pr view failed for ${url}: ${error.message}`));
                    return;
                }
                try {
                    resolve(JSON.parse(stdout) as GhPrState);
                } catch {
                    reject(new Error(`Failed to parse gh output for ${url}: ${stdout}`));
                }
            }
        );
    });
}

/** Convert raw GitHub API state + isDraft to our PullRequestState. */
export function normalizeGhState(raw: GhPrState): PullRequestState {
    if (raw.state === "MERGED") return "merged";
    if (raw.state === "CLOSED") return "closed";
    return raw.isDraft ? "draft" : "open";
}

/**
 * Interface for accessing and updating tasks — fulfilled by TaskManager.
 * Kept as an interface so the poller can be unit-tested without a real
 * TaskManager.
 */
export interface TaskAccessor {
    listAllTasks(): Task[];
    updatePrState(taskId: string, prUrl: string, state: PullRequestState): void;
}

/**
 * Optional query function override — primarily for testing.
 * Defaults to the real `ghQuery` that calls the `gh` CLI.
 */
export type GhQueryFn = (url: string, token?: string) => Promise<GhPrState>;

export class PrPoller {
    private intervalId?: ReturnType<typeof setInterval>;
    private accessor: TaskAccessor;
    private config: Config;
    private intervalMs: number;
    private queryFn: GhQueryFn;

    constructor(
        accessor: TaskAccessor,
        config: Config,
        intervalMs: number = DEFAULT_INTERVAL_MS,
        queryFn: GhQueryFn = ghQuery
    ) {
        this.accessor = accessor;
        this.config = config;
        this.intervalMs = intervalMs;
        this.queryFn = queryFn;
    }

    /** Start periodic polling. Safe to call multiple times (idempotent). */
    start(): void {
        if (this.intervalId) return;
        this.intervalId = setInterval(() => {
            this.pollAll().catch((err) =>
                console.error("[pr-poller] Unhandled error during poll:", err)
            );
        }, this.intervalMs);
        // Unref so the timer doesn't prevent the process from exiting
        this.intervalId.unref?.();
        console.log(
            `[pr-poller] Started — polling every ${this.intervalMs / 1000}s`
        );
    }

    /** Stop periodic polling. */
    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }

    /**
     * Run a single polling cycle: check all open/draft PRs across all tasks
     * and update their state if it changed.
     *
     * Exported for testing and for triggering a manual poll on startup.
     */
    async pollAll(): Promise<void> {
        const tasks = this.accessor.listAllTasks();

        // Collect all PRs that need checking: open, draft, or unknown state
        const toCheck: Array<{
            taskId: string;
            pr: PullRequest;
            token: string | undefined;
        }> = [];

        for (const task of tasks) {
            if (!task.pullRequests?.length) continue;
            const projectConfig = this.config.projects[task.projectId as string];
            const token = projectConfig?.auth?.githubToken;

            for (const pr of task.pullRequests) {
                if (
                    pr.state === "merged" ||
                    pr.state === "closed"
                ) {
                    // Terminal — no need to re-check
                    continue;
                }
                toCheck.push({ taskId: task.taskId as string, pr, token });
            }
        }

        if (toCheck.length === 0) return;

        console.log(`[pr-poller] Checking ${toCheck.length} open pull request(s)...`);

        // Check all PRs concurrently (respects GitHub rate limits reasonably for
        // typical usage; add throttling if needed at scale)
        const results = await Promise.allSettled(
            toCheck.map(async ({ taskId, pr, token }) => {
                const raw = await this.queryFn(pr.url, token);
                const newState = normalizeGhState(raw);
                if (newState !== pr.state) {
                    console.log(
                        `[pr-poller] PR ${pr.url} state changed: ${pr.state ?? "unknown"} → ${newState}`
                    );
                    this.accessor.updatePrState(taskId, pr.url, newState);
                } else {
                    // Update lastCheckedAt even when state didn't change
                    this.accessor.updatePrState(taskId, pr.url, newState);
                }
            })
        );

        const errors = results.filter((r) => r.status === "rejected");
        if (errors.length > 0) {
            for (const err of errors) {
                if (err.status === "rejected") {
                    console.warn(
                        "[pr-poller] Failed to check PR:",
                        err.reason instanceof Error
                            ? err.reason.message
                            : String(err.reason)
                    );
                }
            }
        }
    }
}
