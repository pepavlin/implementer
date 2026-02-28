export type TaskStatus =
    | "queued"
    | "starting"
    | "running"
    | "retrying"
    | "completed"
    | "failed"
    | "interrupted"
    | "cancelled";

export interface PullRequest {
    repo: string;
    url: string;
    state: "open" | "draft" | "merged" | "closed" | null;
}

export interface Task {
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

export interface TaskDetail extends Task {
    branch: string | null;
    parentTaskId: string | null;
    chainId: string | null;
    attempt: number;
    maxAttempts: number | null;
    nextRetryAt: string | null;
    output: string | null;
    error: string | null;
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

export interface ProjectStats {
    running: number;
    starting: number;
    queued: number;
    retrying: number;
    completed: number;
    failed: number;
    interrupted: number;
}

export interface DashboardData {
    tasks: Task[];
    stats: Stats;
    projects: Record<string, ProjectStats>;
}
