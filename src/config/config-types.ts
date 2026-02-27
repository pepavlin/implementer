import { z } from "zod";

export interface ServerConfig {
    workspaceDir: string;
    /** Global cap on tasks running simultaneously across all projects. */
    maxConcurrentTasks?: number;
    /** Password required to access the /dashboard admin UI. */
    adminPassword?: string;
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

export interface ErrorRetryConfig {
    /** Total number of attempts including the first (e.g. 5 = 1 original + 4 retries). */
    maxAttempts: number;
    /** Seconds to wait between attempts. */
    delaySeconds: number;
}
export interface DefaultsConfig {
    systemPrompt?: string;
    mcpServers?: Record<string, McpServerConfig>;
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

const ServerSchema = z
    .object({
        workspaceDir: z.string().default("./workspace"),
        maxConcurrentTasks: z.number().int().min(1).optional(),
        adminPassword: z.string().optional()
    })
    .strict();

const RepositorySchema = z
    .object({
        name: z.string().min(1),
        url: z.string().min(1),
        defaultBranch: z.string().default("main")
    })
    .strict();

const McpServerSchema = z
    .object({
        type: z.string().optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
        url: z.string().optional(),
        headers: z.record(z.string()).optional()
    })
    .strict();

const ClaudeCodeSchema = z
    .object({
        command: z.string().default("claude"),
        model: z.string().optional(),
        systemPrompt: z.string().optional(),
        mcpServers: z.record(McpServerSchema).optional(),
        maxOutputTokens: z.number().int().min(1).optional()
    })
    .strict();

const ProjectAuthSchema = z
    .object({
        anthropicApiKey: z.string().optional(),
        claudeOauthToken: z.string().optional(),
        claudeOauthRefreshToken: z.string().optional(),
        githubToken: z.string().optional()
    })
    .strict();

const ErrorRetrySchema = z
    .object({
        maxAttempts: z.number().int().min(2),
        delaySeconds: z.number().int().min(0).default(60)
    })
    .strict();

const DefaultsSchema = z
    .object({
        systemPrompt: z.string().optional(),
        mcpServers: z.record(McpServerSchema).optional()
    })
    .strict();

const ProjectSchema = z
    .object({
        apiKey: z.string().optional(),
        maxConcurrentTasks: z.number().int().min(1).optional(),
        repositories: z.array(RepositorySchema).min(1),
        claudeCode: ClaudeCodeSchema.default({}),
        auth: ProjectAuthSchema.optional(),
        errorRetry: ErrorRetrySchema.optional(),
        protectedPaths: z.array(z.string()).optional()
    })
    .strict();

export const ConfigSchema = z
    .object({
        server: ServerSchema.default({}),
        defaults: DefaultsSchema.optional(),
        projects: z
            .record(ProjectSchema)
            .refine((projects) => Object.keys(projects).length >= 1, {
                message: "At least one project must be configured"
            })
    })
    .strict();
