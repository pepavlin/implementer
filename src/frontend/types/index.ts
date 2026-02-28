export type TaskStatus =
    | "queued"
    | "starting"
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
    state?: PullRequestState;
}

export interface DashboardTask {
    taskId: string;
    projectId: string;
    title: string | null;
    prompt: string;
    status: TaskStatus;
    startedAt: string;
    completedAt: string | null;
    durationSeconds: number | null;
    estimatedDurationSeconds: number | null;
    pullRequests: PullRequest[] | null;
}

export interface TaskDetail extends DashboardTask {
    output: string;
    error: string | null;
    attempt: number;
    nextRetryAt?: string;
    parentTaskId?: string;
    chainId: string;
}

export interface Stats {
    running: number;
    starting: number;
    queued: number;
    retrying: number;
    completed: number;
    failed: number;
    interrupted: number;
    total: number;
    openPrs: number;
    draftPrs: number;
}

export type ProjectStats = Record<string, number>;

export interface DashboardData {
    tasks: DashboardTask[];
    stats: Stats;
    projects: Record<string, ProjectStats>;
}

export type StatusFilter =
    | "all"
    | "running"
    | "queued"
    | "retrying"
    | "completed"
    | "failed"
    | "interrupted";
