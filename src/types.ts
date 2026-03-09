import { WorkspaceId } from "./workspace-pool";

export type ProjectId = string & { readonly _brand: unique symbol };
export type TaskId = string & { readonly _brand: unique symbol };
export type ChainId = string & { readonly _brand: unique symbol };

export type TaskPriority = "low" | "normal" | "high" | "critical";

/** Numeric weights for priority levels — higher = more important. */
export const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
    low: 0,
    normal: 1,
    high: 2,
    critical: 3
};

export type TaskStatus =
    | "queued"
    | "starting"
    | "running"
    | "retrying"
    | "waiting_for_pipeline"
    | "completed"
    | "failed"
    | "interrupted"
    | "cancelled";

export type PullRequestState = "open" | "draft" | "merged" | "closed";

export interface PullRequest {
    repo: string;
    url: string;
    /** Current state of the pull request, refreshed by the PR poller. */
    state?: PullRequestState;
    /** ISO timestamp of the last time the state was checked from GitHub. */
    lastCheckedAt?: string;
}

export type Branch = {
    name: string;
    createdAt: string;
};

export interface TaskData {
    taskId: TaskId;
    projectId: ProjectId;
    branch?: Branch;
    prompt: string;
    title?: string;
    status: TaskStatus;
    createdAt: string;
    /** ISO timestamp of when the task transitioned out of "queued" and began active processing.
     *  Set at the "starting" transition. Used for accurate duration calculation (excludes queue wait time). */
    startedAt?: string;
    completedAt: string | null;
    nextRetryAt?: string; // ISO timestamp for when the next retry will be attempted, if status is "retrying"
    output: string;
    error?: string;
    pullRequests?: PullRequest[];
    callbackUrl?: string;
    /** Direct parent in chain (the task this one continues from). */
    parentTaskId?: TaskId;
    /** Root task ID of the chain (first task in the lineage). */
    chainId: ChainId;
    /** Current attempt number (1-indexed). Incremented on each retry. */
    attempt: number;
    /** AI-estimated duration of this task in seconds, generated before execution starts. */
    estimatedDurationSeconds?: number;
    /** ISO timestamp of when a dashboard user first opened/viewed this completed task. Shared across devices. */
    readAt?: string;
    /** Priority level for queue ordering. Higher priority tasks are dequeued first. Defaults to "normal". */
    priority: TaskPriority;
    /**
     * Tracks how many automatic pipeline-fix retries have been made for this task in the chain.
     * Set on tasks created automatically when a pipeline check fails and handlePipelines.retryCount > 0.
     * Used to enforce the retryCount limit for pipeline-triggered retries.
     */
    pipelineRetryAttempt?: number;
}

export interface PersistedTask extends TaskData {
    workspaceId?: WorkspaceId;
}

export interface TaskCreateRequest {
    prompt: string;
    /** Task ID to continue from (inherits branch and chain). */
    continueTaskId?: TaskId;
    callbackUrl?: string;
    /** Priority for queue ordering. Defaults to "normal" if omitted. */
    priority?: TaskPriority;
}
