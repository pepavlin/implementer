import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { Config } from "./types.js";

/** Replace ${VAR_NAME} references with environment variable values. */
function interpolateEnv(value: string): string {
    return value.replace(
        /\$\{([^}]+)\}/g,
        (_, name: string) => process.env[name] ?? ""
    );
}

const ServerSchema = z
    .object({
        workspaceDir: z.string().default("./workspace"),
        maxConcurrentTasks: z.number().int().min(1).optional(),
        maxTokensPerHour: z.number().int().min(1).optional(),
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

const ConfigSchema = z
    .object({
        server: ServerSchema.default({}),
        projects: z
            .record(ProjectSchema)
            .refine((projects) => Object.keys(projects).length >= 1, {
                message: "At least one project must be configured"
            })
    })
    .strict();

function normalizeValidatedConfig(
    validated: Config,
    resolvedPath: string
): Config {
    // Resolve workspaceDir to absolute path relative to config file location
    validated.server.workspaceDir = resolve(
        resolvedPath,
        "..",
        validated.server.workspaceDir
    );

    // Interpolate ${VAR} references in server config
    if (validated.server.adminPassword) {
        validated.server.adminPassword = interpolateEnv(validated.server.adminPassword);
    }

    // Interpolate ${VAR} references in auth and apiKey fields
    for (const project of Object.values(validated.projects)) {
        if (project.apiKey) {
            project.apiKey = interpolateEnv(project.apiKey);
        }
        if (project.auth) {
            if (project.auth.anthropicApiKey) {
                project.auth.anthropicApiKey = interpolateEnv(
                    project.auth.anthropicApiKey
                );
            }
            if (project.auth.claudeOauthToken) {
                project.auth.claudeOauthToken = interpolateEnv(
                    project.auth.claudeOauthToken
                );
            }
            if (project.auth.claudeOauthRefreshToken) {
                project.auth.claudeOauthRefreshToken = interpolateEnv(
                    project.auth.claudeOauthRefreshToken
                );
            }
            if (project.auth.githubToken) {
                project.auth.githubToken = interpolateEnv(
                    project.auth.githubToken
                );
            }
        }
    }

    return validated;
}

export function validateConfigFile(configPath?: string): Config {
    const resolvedPath = resolve(configPath ?? "config.yaml");
    const raw = readFileSync(resolvedPath, "utf-8");
    const parsed = yaml.load(raw);
    const validated = ConfigSchema.parse(parsed);
    return normalizeValidatedConfig(validated, resolvedPath);
}

export function loadConfig(configPath?: string): Config {
    return validateConfigFile(configPath);
}
