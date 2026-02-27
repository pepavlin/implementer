import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import {
    ServerConfig,
    ProjectConfig,
    DefaultsConfig,
    ConfigSchema
} from "./config-types";
import { NotFoundError, UnauthorizedError } from "../errors";
import { ProjectId } from "../types";

export class Config {
    server: ServerConfig;
    projects: Record<string, ProjectConfig>;
    configPath: string;

    constructor(configPath?: string) {
        this.configPath = resolve(configPath ?? "config.yaml");

        const data = this.validateAndGetConfig();
        this.server = data.server;
        this.projects = data.projects;

        const projectIds = Object.keys(data.projects);
        console.log(
            `Config loaded. ${projectIds.length} project(s) configured: ${projectIds.join(", ")}`
        );
    }

    static load(configPath?: string) {
        return new Config(configPath);
    }

    private validateAndGetConfig() {
        const resolvedPath = resolve(this.configPath ?? "config.yaml");
        const raw = readFileSync(resolvedPath, "utf-8");
        const parsed = yaml.load(raw);
        const validated = ConfigSchema.parse(parsed);

        // Resolve workspaceDir to absolute path relative to config file location
        validated.server.workspaceDir = resolve(
            resolvedPath,
            "..",
            validated.server.workspaceDir
        );

        // Merge global defaults into each project's claudeCode
        if (validated.defaults) {
            this.applyDefaults(validated.projects, validated.defaults);
        }

        return validated;
    }

    private applyDefaults(
        projects: Record<string, ProjectConfig>,
        defaults: DefaultsConfig
    ): void {
        for (const project of Object.values(projects)) {
            // systemPrompt: concatenate global + project (newline-separated)
            if (defaults.systemPrompt) {
                project.claudeCode.systemPrompt = project.claudeCode.systemPrompt
                    ? `${defaults.systemPrompt}\n${project.claudeCode.systemPrompt}`
                    : defaults.systemPrompt;
            }

            // mcpServers: shallow merge — project keys override global keys
            if (defaults.mcpServers) {
                project.claudeCode.mcpServers = {
                    ...defaults.mcpServers,
                    ...project.claudeCode.mcpServers
                };
            }
        }
    }

    getProjectIdByToken(projectToken: string): ProjectId | null {
        // Check explicit API key match first
        for (const [projectId, project] of Object.entries(this.projects)) {
            if (project.apiKey && project.apiKey === projectToken) {
                return projectId as ProjectId;
            }
        }

        // Dev mode: single project with no apiKey configured — allow any token
        const projectEntries = Object.entries(this.projects);
        if (
            projectEntries.length === 1 &&
            !projectEntries[0][1].apiKey
        ) {
            return projectEntries[0][0] as ProjectId;
        }

        return null;
    }
}

/**
 * Validate a config file and return the parsed data.
 * Throws if the file cannot be read or the config is invalid.
 */
export function validateConfigFile(configPath: string): { server: ServerConfig; projects: Record<string, ProjectConfig> } {
    const resolvedPath = resolve(configPath);
    const raw = readFileSync(resolvedPath, "utf-8");
    const parsed = yaml.load(raw);
    const validated = ConfigSchema.parse(parsed);
    return { server: validated.server, projects: validated.projects };
}
