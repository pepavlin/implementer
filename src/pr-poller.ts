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
    /**
     * Final conclusion — may be absent or empty string while check is in progress.
     * Not all versions of the `gh` CLI expose this as a JSON field; treat as optional.
     */
    conclusion?: string;
}

/** Overall pipeline status derived from a set of check runs. */
export type PipelineCheckStatus = "passing" | "failing" | "pending";

const PASSING_STATES = new Set([
    "SUCCESS",
    "NEUTRAL",
    "SKIPPED",
    // CANCELLED is treated as a neutral/passing outcome: GitHub auto-cancels
    // jobs when a newer run supersedes the current one (concurrency groups),
    // or when a matrix job fails with fail-fast=true. In both cases the
    // cancellation is not a code defect, so we should not trigger a fix-retry.
    "CANCELLED",
    // STALE is treated as a neutral/passing outcome: GitHub marks a check run
    // as stale when the PR's commit was updated and the old check run is no
    // longer relevant. A stale check is a terminal state that cannot change,
    // so waiting for it to complete would block the task forever.
    "STALE",
    // EXPECTED is used by GitHub legacy required status checks as a placeholder
    // for a check that is "expected" but has not been submitted. If the
    // external service never reports, the check stays "expected" forever.
    // Treat it as a neutral passing state to avoid blocking the task indefinitely.
    "EXPECTED"
]);

const FAILING_STATES = new Set([
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "ACTION_REQUIRED"
]);

/**
 * Resolve the effective state of a single check run.
 *
 * The `state` field returned by `gh pr checks` reflects the check's current
 * GitHub status (e.g. PENDING, SUCCESS, CANCELLED). However, for jobs that
 * were QUEUED when a workflow run was auto-cancelled, the GitHub API can
 * return `state: "PENDING"` (from the QUEUED status) while simultaneously
 * setting `conclusion: "CANCELLED"`.  In that case `state` alone is
 * misleading and would cause the poller to wait forever.
 *
 * Resolution rules:
 *  1. If `state` is already a recognised terminal value (in PASSING_STATES or
 *     FAILING_STATES) → use `state` directly.
 *  2. Otherwise, if `conclusion` is non-empty → use `conclusion` (it is more
 *     authoritative once a check run has finished).
 *  3. Otherwise → use `state` as-is (e.g. "PENDING" for a running check).
 */
function resolveCheckState(check: GhCheckRun): string {
    const stateUpper = (check.state || "").toUpperCase();
    const conclusionUpper = (check.conclusion || "").toUpperCase();

    if (PASSING_STATES.has(stateUpper) || FAILING_STATES.has(stateUpper)) {
        return stateUpper;
    }
    return conclusionUpper || stateUpper;
}

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
 *
 * @param logPrefix Optional prefix for debug log lines (e.g. task ID + PR URL).
 */
export function analyzePipelineChecks(
    checks: GhCheckRun[],
    pipelineNames?: string[],
    logPrefix?: string
): {
    status: PipelineCheckStatus;
    failedCheck?: string;
} {
    // Filter to only the requested pipeline jobs if a list was provided
    const relevant =
        pipelineNames && pipelineNames.length > 0
            ? checks.filter((c) => pipelineNames.includes(c.name))
            : checks;

    // Debug: log all resolved check states when a prefix is provided
    if (logPrefix && checks.length > 0) {
        const checkSummary = checks
            .map((c) => {
                const resolved = resolveCheckState(c);
                const category = PASSING_STATES.has(resolved)
                    ? "pass"
                    : FAILING_STATES.has(resolved)
                      ? "fail"
                      : "pending";
                return `${c.name}(state=${c.state},conclusion=${c.conclusion},resolved=${resolved},${category})`;
            })
            .join("; ");
        console.log(`[pr-poller] ${logPrefix} checks: ${checkSummary}`);
        if (pipelineNames && pipelineNames.length > 0 && relevant.length < checks.length) {
            const ignoredNames = checks
                .filter((c) => !pipelineNames.includes(c.name))
                .map((c) => c.name)
                .join(", ");
            console.log(
                `[pr-poller] ${logPrefix} ignoring non-configured checks: ${ignoredNames}`
            );
        }
    }

    if (relevant.length === 0) {
        if (pipelineNames && pipelineNames.length > 0) {
            // None of the configured pipeline names appear in the check runs.
            if (checks.length === 0) {
                // No checks at all — CI hasn't started yet, keep waiting.
                if (logPrefix) {
                    console.log(`[pr-poller] ${logPrefix} no checks yet — pending`);
                }
                return { status: "pending" };
            }
            // Checks exist but none match the configured names.
            // If some checks are still in-progress, the configured pipeline jobs
            // might be triggered later (e.g. as downstream jobs) — keep waiting.
            // If ALL existing checks are in a terminal state (passing or failing),
            // the configured pipeline jobs were never triggered — they likely have
            // wrong names in the config. Complete the task to avoid blocking forever.
            const allTerminal = checks.every((c) => {
                const state = resolveCheckState(c);
                return PASSING_STATES.has(state) || FAILING_STATES.has(state);
            });
            if (logPrefix) {
                console.log(
                    `[pr-poller] ${logPrefix} none of configured pipelines [${pipelineNames.join(", ")}] found; allTerminal=${allTerminal} → ${allTerminal ? "passing" : "pending"}`
                );
            }
            return allTerminal ? { status: "passing" } : { status: "pending" };
        }
        // No filter — no checks means no CI configured; treat as passing.
        if (logPrefix) {
            console.log(`[pr-poller] ${logPrefix} no checks and no filter → passing`);
        }
        return { status: "passing" };
    }

    for (const check of relevant) {
        const state = resolveCheckState(check);
        if (FAILING_STATES.has(state)) {
            return { status: "failing", failedCheck: check.name };
        }
    }

    for (const check of relevant) {
        const state = resolveCheckState(check);
        if (!PASSING_STATES.has(state)) {
            // Still pending or unknown — keep waiting
            if (logPrefix) {
                console.log(
                    `[pr-poller] ${logPrefix} check "${check.name}" still pending (resolved=${state})`
                );
            }
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
            ["pr", "checks", url, "--json", "name,state"],
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
    /** ISO timestamp of when the task first entered "waiting_for_pipeline" status. */
    pipelineWaitingSince?: string;
    /** GitHub token override for dynamic (non-preconfigured) tasks. */
    githubToken?: string;
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
        // Run an immediate poll on startup so that tasks whose pipelines completed
        // while the implementer was down are resolved without waiting a full interval.
        this.pollAll().catch((err) =>
            console.error("[pr-poller] Unhandled error during initial poll:", err)
        );
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
     * Trigger an immediate poll for a specific project's tasks only.
     * Used by the webhook handler to avoid waiting for the next polling cycle.
     *
     * Debounced: if called multiple times in rapid succession for the same project,
     * only one poll executes (subsequent calls within the debounce window are no-ops).
     */
    private _projectPollInFlight = new Set<string>();

    async pollProject(projectId: string): Promise<void> {
        // Simple deduplication: skip if a poll for this project is already running
        if (this._projectPollInFlight.has(projectId)) {
            console.log(
                `[pr-poller] Poll already in progress for project "${projectId}" — skipping duplicate`
            );
            return;
        }

        this._projectPollInFlight.add(projectId);
        try {
            console.log(
                `[pr-poller] Webhook-triggered poll for project "${projectId}"`
            );
            const allTasks = this.accessor.listAllTasks();
            const projectTasks = allTasks.filter(
                (t) => t.projectId === projectId
            );

            if (projectTasks.length === 0) {
                console.log(
                    `[pr-poller] No pollable tasks for project "${projectId}"`
                );
                return;
            }

            // Part 1: PR state polling for this project
            const toCheck: Array<{
                taskId: string;
                pr: PullRequest;
                token: string | undefined;
            }> = [];

            for (const task of projectTasks) {
                if (!task.pullRequests?.length) continue;
                const projectConfig =
                    this.config.projects[task.projectId as ProjectId];
                const token = task.githubToken ?? projectConfig?.data.auth?.githubToken;

                for (const pr of task.pullRequests) {
                    if (pr.state === "merged" || pr.state === "closed") continue;
                    toCheck.push({ taskId: task.taskId, pr, token });
                }
            }

            if (toCheck.length > 0) {
                console.log(
                    `[pr-poller] [webhook] Checking ${toCheck.length} open PR(s) for project "${projectId}"`
                );
                for (const item of toCheck) {
                    try {
                        const raw = await this.queryFn(item.pr.url, item.token);
                        const newState = normalizeGhState(raw);
                        if (newState !== item.pr.state) {
                            console.log(
                                `[pr-poller] [webhook] PR ${item.pr.url} state changed: ${item.pr.state ?? "unknown"} → ${newState}`
                            );
                        }
                        this.accessor.updatePrState(
                            item.taskId,
                            item.pr.url,
                            newState
                        );
                    } catch (err) {
                        console.warn(
                            "[pr-poller] [webhook] Failed to check PR:",
                            err instanceof Error ? err.message : String(err)
                        );
                    }
                }
            }

            // Part 2: Pipeline checks for waiting_for_pipeline tasks in this project
            const pipelineTasks = projectTasks.filter(
                (t) =>
                    t.status === "waiting_for_pipeline" &&
                    t.pullRequests?.length
            );

            if (pipelineTasks.length > 0) {
                console.log(
                    `[pr-poller] [webhook] Checking pipeline status for ${pipelineTasks.length} waiting task(s) in project "${projectId}"`
                );
                for (const task of pipelineTasks) {
                    await this.checkPipelineForTask(task);
                }
            }
        } finally {
            this._projectPollInFlight.delete(projectId);
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
            const token = task.githubToken ?? projectConfig?.data.auth?.githubToken;

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
     *
     * Also enforces the handlePipelines.timeoutHours safety net: if the task has
     * been waiting longer than the configured timeout, it is auto-completed with a
     * warning to prevent indefinite blocking on unresolvable check states.
     */
    private async checkPipelineForTask(task: PollableTask): Promise<void> {
        const projectConfig =
            this.config.projects[task.projectId as ProjectId];
        const token = task.githubToken ?? projectConfig?.data.auth?.githubToken;
        // Retrieve the configured pipeline job names to watch (if any)
        const pipelineNames =
            projectConfig?.data.handlePipelines?.pipelines ?? [];
        // Default timeout: 8 hours. Set to 0 to disable.
        const timeoutHours =
            projectConfig?.data.handlePipelines?.timeoutHours ?? 8;
        const pullRequests = task.pullRequests ?? [];

        // ── Timeout safety net ───────────────────────────────────────────────
        // If the task has been stuck in "waiting_for_pipeline" longer than the
        // configured timeout, auto-complete it to avoid blocking indefinitely.
        // This covers unresolvable states like GitHub EXPECTED checks, WAITING
        // environment-approval gates, or persistent gh CLI errors.
        if (timeoutHours > 0 && task.pipelineWaitingSince) {
            const waitingMs =
                Date.now() - new Date(task.pipelineWaitingSince).getTime();
            const timeoutMs = timeoutHours * 60 * 60 * 1000;
            if (waitingMs >= timeoutMs) {
                console.warn(
                    `[pr-poller] Task ${task.taskId} has been waiting for pipeline checks ` +
                    `for ${Math.round(waitingMs / 3600000 * 10) / 10}h ` +
                    `(timeout: ${timeoutHours}h) — auto-completing to unblock the chain. ` +
                    `If this is unexpected, check the check states on the PR and review ` +
                    `handlePipelines.timeoutHours in your config.`
                );
                this.accessor.completePipelineTask(task.taskId);
                return;
            }
        }

        let overallStatus: PipelineCheckStatus = "passing";
        let failedCheckName: string | undefined;

        for (const pr of pullRequests) {
            // Skip terminal PR states (merged/closed) — they won't get new checks
            if (pr.state === "merged" || pr.state === "closed") continue;

            const logPrefix = `task ${task.taskId} PR ${pr.url}:`;
            try {
                const checks = await this.checksQueryFn(pr.url, token);
                const { status, failedCheck } = analyzePipelineChecks(
                    checks,
                    pipelineNames,
                    logPrefix
                );

                // Warn when configured pipeline names never appeared despite other
                // checks finishing — this usually means the names in the config are wrong.
                if (
                    status === "passing" &&
                    pipelineNames.length > 0 &&
                    checks.length > 0 &&
                    !checks.some((c) => pipelineNames.includes(c.name))
                ) {
                    console.warn(
                        `[pr-poller] Task ${task.taskId}: configured pipeline name(s) ` +
                        `[${pipelineNames.join(", ")}] were not found in PR ${pr.url} checks. ` +
                        `All other checks finished — completing task. ` +
                        `Check handlePipelines.pipelines in your config for typos.`
                    );
                }

                if (status === "failing") {
                    overallStatus = "failing";
                    failedCheckName = failedCheck;
                    break; // No need to check remaining PRs
                } else if (status === "pending") {
                    overallStatus = "pending";
                    // Don't break — there might be a failing check in a later PR
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.warn(
                    `[pr-poller] Failed to check pipeline for PR ${pr.url}: ${errMsg}`
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
