/**
 * PrPoller — background service that periodically checks the status of open
 * pull requests on GitHub and updates the stored state on tasks.
 *
 * Only pull requests whose state is "open", "draft", or not yet set are
 * polled. Merged and closed PRs are terminal states and never change.
 *
 * Additionally, for tasks in "waiting_for_pipeline" status, the poller checks
 * GitHub CI/CD pipeline checks on the PR. When all checks pass, the task is
 * completed. When any check fails, the task is failed.
 *
 * Uses the `gh` CLI (same as git-manager) with the project's GitHub token.
 */

import { execFile } from "node:child_process";
import type { Config } from "./config/config.js";
import type {
    ProjectId,
    PullRequest,
    PullRequestState
} from "./types.js";

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
                    reject(
                        new Error(
                            `gh pr view failed for ${url}: ${error.message}`
                        )
                    );
                    return;
                }
                try {
                    resolve(JSON.parse(stdout) as GhPrState);
                } catch {
                    reject(
                        new Error(
                            `Failed to parse gh output for ${url}: ${stdout}`
                        )
                    );
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

// ── Pipeline checks ──────────────────────────────────────────────────────────

/** A single GitHub check run or status check returned by `gh pr checks`. */
export interface GhCheckRun {
    name: string;
    /** Overall check state. Values: SUCCESS, FAILURE, ERROR, PENDING, CANCELLED,
     *  SKIPPED, NEUTRAL, STALE, TIMED_OUT, ACTION_REQUIRED, or empty string. */
    state: string;
    /** Final conclusion — may be empty string while check is in progress. */
    conclusion: string;
}

/** Overall pipeline status derived from a set of check runs. */
export type PipelineCheckStatus = "passing" | "failing" | "pending";

const PASSING_STATES = new Set([
    "SUCCESS",
    "NEUTRAL",
    "SKIPPED"
]);

const FAILING_STATES = new Set([
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "CANCELLED"
]);

/**
 * Derive the overall pipeline status from a list of GitHub check runs.
 *
 * When `pipelineNames` is provided and non-empty, only checks whose name
 * appears in that list are evaluated. If none of the listed checks are
 * present yet the status is "pending" (waiting for them to start).
 *
 * - No relevant checks → "passing" when no filter, "pending" when filter provided
 * - Any relevant check in a failing terminal state → "failing"
 * - All relevant checks in passing terminal states → "passing"
 * - Any relevant check still pending/in-progress → "pending"
 */
export function analyzePipelineChecks(
    checks: GhCheckRun[],
    pipelineNames?: string[]
): {
    status: PipelineCheckStatus;
    failedCheck?: string;
} {
    // Filter to only the requested pipeline jobs if a list was provided
    const relevant =
        pipelineNames && pipelineNames.length > 0
            ? checks.filter((c) => pipelineNames.includes(c.name))
            : checks;

    if (relevant.length === 0) {
        // No matching checks found yet — if we're waiting for specific pipelines,
        // treat as pending until they appear. Otherwise treat as passing (no CI).
        return pipelineNames && pipelineNames.length > 0
            ? { status: "pending" }
            : { status: "passing" };
    }

    for (const check of relevant) {
        const state = (check.state || check.conclusion || "").toUpperCase();
        if (FAILING_STATES.has(state)) {
            return { status: "failing", failedCheck: check.name };
        }
    }

    for (const check of relevant) {
        const state = (check.state || check.conclusion || "").toUpperCase();
        if (!PASSING_STATES.has(state)) {
            // Still pending or unknown — keep waiting
            return { status: "pending" };
        }
    }

    return { status: "passing" };
}

/**
 * Query pipeline check runs for a PR using `gh pr checks`.
 * Returns an empty array if there are no checks configured for the PR.
 */
function ghChecksQuery(url: string, token?: string): Promise<GhCheckRun[]> {
    return new Promise((resolve, reject) => {
        const env = token ? { ...process.env, GH_TOKEN: token } : undefined;
        execFile(
            "gh",
            ["pr", "checks", url, "--json", "name,state,conclusion"],
            { env, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout) => {
                if (error) {
                    reject(
                        new Error(
                            `gh pr checks failed for ${url}: ${error.message}`
                        )
                    );
                    return;
                }
                try {
                    const parsed = JSON.parse(stdout);
                    resolve(Array.isArray(parsed) ? (parsed as GhCheckRun[]) : []);
                } catch {
                    reject(
                        new Error(
                            `Failed to parse gh pr checks output for ${url}: ${stdout}`
                        )
                    );
                }
            }
        );
    });
}

// ── Interfaces ───────────────────────────────────────────────────────────────

/**
 * Interface for accessing and updating tasks — fulfilled by TaskManager.
 * Kept as an interface so the poller can be unit-tested without a real
 * TaskManager.
 */
/** Minimal view of a task needed by the poller. */
export interface PollableTask {
    taskId: string;
    projectId: string;
    pullRequests?: PullRequest[];
    /** Task status — used to identify "waiting_for_pipeline" tasks. */
    status: string;
}

export interface TaskAccessor {
    listAllTasks(): PollableTask[];
    updatePrState(taskId: string, prUrl: string, state: PullRequestState): void;
    /** Complete a task that was waiting for pipeline checks (all checks passed). */
    completePipelineTask(taskId: string): void;
    /**
     * Handle a pipeline failure for a waiting task. The TaskManager decides
     * whether to fail the task outright or schedule an automatic pipeline-fix
     * retry based on handlePipelines.retryCount configuration.
     */
    handlePipelineFailure(taskId: string, error: string): void;
}

/**
 * Optional query function override — primarily for testing.
 * Defaults to the real `ghQuery` that calls the `gh` CLI.
 */
export type GhQueryFn = (url: string, token?: string) => Promise<GhPrState>;

/**
 * Optional pipeline checks query function override — primarily for testing.
 * Defaults to the real `ghChecksQuery` that calls the `gh` CLI.
 */
export type GhChecksQueryFn = (
    url: string,
    token?: string
) => Promise<GhCheckRun[]>;

/** Default max concurrent PR queries — kept low to avoid overwhelming the server. */
const DEFAULT_CONCURRENCY = 1;

export class PrPoller {
    private intervalId?: ReturnType<typeof setInterval>;
    private accessor: TaskAccessor;
    private config: Config;
    private intervalMs: number;
    private queryFn: GhQueryFn;
    private checksQueryFn: GhChecksQueryFn;
    private concurrency: number;

    constructor(
        accessor: TaskAccessor,
        config: Config,
        intervalMs: number = DEFAULT_INTERVAL_MS,
        queryFn: GhQueryFn = ghQuery,
        concurrency: number = DEFAULT_CONCURRENCY,
        checksQueryFn: GhChecksQueryFn = ghChecksQuery
    ) {
        this.accessor = accessor;
        this.config = config;
        this.intervalMs = intervalMs;
        this.queryFn = queryFn;
        this.concurrency = Math.max(1, concurrency);
        this.checksQueryFn = checksQueryFn;
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
     * Also checks pipeline checks for tasks in "waiting_for_pipeline" status
     * and completes/fails them as appropriate.
     *
     * Exported for testing and for triggering a manual poll on startup.
     */
    async pollAll(): Promise<void> {
        const tasks = this.accessor.listAllTasks();

        // ── Part 1: PR state polling ─────────────────────────────────────────
        // Collect all PRs that need checking: open, draft, or unknown state
        const toCheck: Array<{
            taskId: string;
            pr: PullRequest;
            token: string | undefined;
        }> = [];

        for (const task of tasks) {
            if (!task.pullRequests?.length) continue;
            const projectConfig =
                this.config.projects[task.projectId as ProjectId];
            const token = projectConfig?.data.auth?.githubToken;

            for (const pr of task.pullRequests) {
                if (pr.state === "merged" || pr.state === "closed") {
                    // Terminal — no need to re-check
                    continue;
                }
                toCheck.push({ taskId: task.taskId, pr, token });
            }
        }

        if (toCheck.length > 0) {
            console.log(
                `[pr-poller] Checking ${toCheck.length} open pull request(s) ` +
                    `(concurrency: ${this.concurrency})...`
            );

            let prErrorCount = 0;

            const processOnePr = async (
                item: (typeof toCheck)[number]
            ): Promise<void> => {
                const { taskId, pr, token } = item;
                try {
                    const raw = await this.queryFn(pr.url, token);
                    const newState = normalizeGhState(raw);
                    if (newState !== pr.state) {
                        console.log(
                            `[pr-poller] PR ${pr.url} state changed: ${pr.state ?? "unknown"} → ${newState}`
                        );
                    }
                    // Always update to refresh lastCheckedAt even when state is unchanged
                    this.accessor.updatePrState(taskId, pr.url, newState);
                } catch (err) {
                    prErrorCount++;
                    console.warn(
                        "[pr-poller] Failed to check PR:",
                        err instanceof Error ? err.message : String(err)
                    );
                }
            };

            if (this.concurrency === 1) {
                for (const item of toCheck) {
                    await processOnePr(item);
                }
            } else {
                const queue = [...toCheck];
                const workers = Array.from(
                    { length: this.concurrency },
                    async () => {
                        while (queue.length > 0) {
                            const item = queue.shift();
                            if (item) await processOnePr(item);
                        }
                    }
                );
                await Promise.all(workers);
            }

            if (prErrorCount > 0) {
                console.warn(
                    `[pr-poller] ${prErrorCount} PR check(s) failed during this cycle.`
                );
            }
        }

        // ── Part 2: Pipeline checks for waiting_for_pipeline tasks ───────────
        const pipelineTasks = tasks.filter(
            (t) => t.status === "waiting_for_pipeline" && t.pullRequests?.length
        );

        if (pipelineTasks.length === 0) return;

        console.log(
            `[pr-poller] Checking pipeline status for ${pipelineTasks.length} waiting task(s)...`
        );

        for (const task of pipelineTasks) {
            await this.checkPipelineForTask(task);
        }
    }

    /**
     * Check all PR pipeline checks for a single "waiting_for_pipeline" task.
     * If all configured pipeline jobs pass → complete the task.
     * If any configured pipeline job fails → delegate to handlePipelineFailure
     *   (which may retry automatically or mark the task as failed).
     * Otherwise → keep waiting (do nothing).
     */
    private async checkPipelineForTask(task: PollableTask): Promise<void> {
        const projectConfig =
            this.config.projects[task.projectId as ProjectId];
        const token = projectConfig?.data.auth?.githubToken;
        // Retrieve the configured pipeline job names to watch (if any)
        const pipelineNames =
            projectConfig?.data.handlePipelines?.pipelines ?? [];
        const pullRequests = task.pullRequests ?? [];

        let overallStatus: PipelineCheckStatus = "passing";
        let failedCheckName: string | undefined;

        for (const pr of pullRequests) {
            // Skip terminal PR states (merged/closed) — they won't get new checks
            if (pr.state === "merged" || pr.state === "closed") continue;

            try {
                const checks = await this.checksQueryFn(pr.url, token);
                const { status, failedCheck } = analyzePipelineChecks(
                    checks,
                    pipelineNames
                );

                if (status === "failing") {
                    overallStatus = "failing";
                    failedCheckName = failedCheck;
                    break; // No need to check remaining PRs
                } else if (status === "pending") {
                    overallStatus = "pending";
                    // Don't break — there might be a failing check in a later PR
                }
            } catch (err) {
                console.warn(
                    `[pr-poller] Failed to check pipeline for PR ${pr.url}:`,
                    err instanceof Error ? err.message : String(err)
                );
                // On error, assume pending (keep waiting)
                overallStatus = "pending";
            }
        }

        if (overallStatus === "passing") {
            console.log(
                `[pr-poller] All pipeline checks passed for task ${task.taskId}.`
            );
            this.accessor.completePipelineTask(task.taskId);
        } else if (overallStatus === "failing") {
            const errorMsg = failedCheckName
                ? `Pipeline check failed: ${failedCheckName}`
                : "Pipeline check failed";
            console.log(
                `[pr-poller] Pipeline check failed for task ${task.taskId}: ${failedCheckName ?? "(unknown)"}`
            );
            this.accessor.handlePipelineFailure(task.taskId, errorMsg);
        }
        // "pending" — do nothing, will be checked again on next poll
    }
}
