import { z } from "zod";

export interface ServerConfig {
    workspaceDir: string;
    /** Global cap on tasks running simultaneously across all projects. */
    maxConcurrentTasks?: number;
    /** Password required to access the /dashboard admin UI. */
    adminPassword?: string;
    /** CPU limit for lightweight metadata containers (slug, title generation). Defaults to 0.4. */
    metaCpus: number;
    /** CPU limit for the main sandbox container running Claude Code. Defaults to 0.4. */
    sandboxCpus: number;
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
    /** Maximum wall-clock seconds a single executor.run() call may take before the container is killed.
     *  Defaults to 3600 (1 hour). Minimum 60 seconds.
     *  When exceeded the task is set to **retrying** (not failed) and its branch is preserved
     *  so the next run (after server restart or manual /retry) continues from where it left off.
     *  Unlike regular failures, timeouts always retry regardless of whether errorRetry is configured. */
    timeoutSeconds?: number;
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
        adminPassword: z.string().optional(),
        metaCpus: z.number().positive().default(0.4),
        sandboxCpus: z.number().positive().default(0.4)
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
        maxOutputTokens: z.number().int().min(1).optional(),
        timeoutSeconds: z.number().int().min(60).default(3600)
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
