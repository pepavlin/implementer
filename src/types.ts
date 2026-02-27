export type ProjectId = string & { readonly _brand: unique symbol };
export type TaskId = string & { readonly _brand: unique symbol };
export type ChainId = string & { readonly _brand: unique symbol };

export type TaskStatus =
    | "queued"
    | "starting"
    | "creating"
    | "running"
    | "retrying"
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

export interface Task {
    taskId: TaskId;
    projectId: ProjectId;
    branch: string | null;
    prompt: string;
    title?: string;
    status: TaskStatus;
    startedAt: string;
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
}

export interface PersistedTask extends Task {
    workspaceId: number | null;
}

export interface TaskCreateRequest {
    prompt: string;
    /** Task ID to continue from (inherits branch and chain). */
    continueTaskId?: TaskId;
    callbackUrl?: string;
}
