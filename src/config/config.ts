import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { ServerConfig, ProjectConfig, ConfigSchema } from "./config-types";
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

        return validated;
    }

    getProjectIdByToken(projectToken: string): ProjectId | null {
        for (const [projectId, project] of Object.entries(this.projects)) {
            if (project.apiKey && project.apiKey === projectToken) {
                return projectId as ProjectId;
            }
        }
        return null;
    }
}
