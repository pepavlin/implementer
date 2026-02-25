export interface ServerConfig {
    workspaceDir: string;
    /** Global cap on tasks running simultaneously across all projects. */
    maxConcurrentTasks?: number;
    /** Max tokens/hour allowed via the OAuth usage API before rejecting new tasks. Only applies in OAuth mode. */
    maxTokensPerHour?: number;
}

export interface RepositoryConfig {
    name: string;
    url: string;
    defaultBranch: string;
}

export interface McpServerConfig {
    type?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
}

export interface ClaudeCodeConfig {
    command: string;
    model?: string;
    systemPrompt?: string;
    mcpServers?: Record<string, McpServerConfig>;
    maxOutputTokens?: number;
}

export interface ProjectAuth {
    anthropicApiKey?: string;
    /** Static OAuth access token (expires in ~1h, no auto-refresh). */
    claudeOauthToken?: string;
    /** OAuth refresh token used to obtain new access tokens automatically. */
    claudeOauthRefreshToken?: string;
    githubToken?: string;
}

export interface ProjectConfig {
    apiKey?: string;
    maxConcurrentTasks?: number;
    repositories: RepositoryConfig[];
    claudeCode: ClaudeCodeConfig;
    auth?: ProjectAuth;
    errorRetry?: ErrorRetryConfig;
    /** Paths (files or directories) that Claude must not modify. Changes to these paths are reverted before PR creation. Supports git pathspec patterns (e.g. ".github", "Dockerfile", "docker-compose*.yml"). */
    protectedPaths?: string[];
}

export interface Config {
    server: ServerConfig;
    projects: Record<string, ProjectConfig>;
}

export type TaskStatus = "queued" | "running" | "retrying" | "completed" | "failed" | "interrupted";

export interface ErrorRetryConfig {
    /** Total number of attempts including the first (e.g. 5 = 1 original + 4 retries). */
    maxAttempts: number;
    /** Seconds to wait between attempts. */
    delaySeconds: number;
}

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
