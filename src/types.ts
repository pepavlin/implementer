export type ProjectId = string & { readonly _brand: unique symbol };

export type TaskStatus =
    | "queued"
    | "running"
    | "retrying"
    | "completed"
    | "failed"
    | "interrupted"
    | "cancelled";

export interface PullRequest {
    repo: string;
    url: string;
}

export interface Task {
    taskId: string;
    projectId: ProjectId;
    branch: string | null;
    prompt: string;
    title?: string;
    status: TaskStatus;
    startedAt: string;
    completedAt: string | null;
    output: string;
    error?: string;
    pullRequests?: PullRequest[];
    callbackUrl?: string;
    /** Direct parent in chain (the task this one continues from). */
    parentTaskId?: string;
    /** Root task ID of the chain (first task in the lineage). */
    chainId?: string;
    /** Current attempt number (1-indexed). Incremented on each retry. */
    attempt: number;
}

export interface PersistedTask extends Task {
    workspaceId: number | null;
}

export interface TaskCreateRequest {
    prompt: string;
    /** Task ID to continue from (inherits branch and chain). */
    continueTaskId?: string;
    callbackUrl?: string;
}
