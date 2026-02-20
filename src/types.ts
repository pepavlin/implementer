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
}

export interface Config {
    server: ServerConfig;
    projects: Record<string, ProjectConfig>;
}

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "interrupted";

export interface PullRequest {
    repo: string;
    url: string;
}

export interface Task {
    taskId: string;
    projectId: string;
    branch: string | null;
    prompt: string;
    status: TaskStatus;
    startedAt: string;
    completedAt: string | null;
    output: string;
    error?: string;
    pullRequests?: PullRequest[];
    callbackUrl?: string;
    /** Original fromBranch value from the create request, needed when dequeuing. */
    fromBranch?: string;
}

export interface PersistedTask extends Task {
    workspaceId: number | null;
}

export interface TaskCreateRequest {
    prompt: string;
    fromBranch?: string;
    callbackUrl?: string;
}
