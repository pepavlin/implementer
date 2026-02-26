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
    projectId: string;
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
    /** Pull request number to continue work on. Tasks with the same PR number run serially. */
    pullRequestNumber?: number;
    /** Current attempt number (1-indexed). Incremented on each retry. */
    attempt: number;
}

export interface PersistedTask extends Task {
    workspaceId: number | null;
}

export interface TaskCreateRequest {
    prompt: string;
    /** Pull request number to continue work on. Tasks with the same PR number run serially. */
    pullRequestNumber?: number;
    callbackUrl?: string;
}
