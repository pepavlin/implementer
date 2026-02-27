import { TokenManager } from "../auth";
import { ProjectId } from "../types";
import { WorkspacePool } from "../workspace-pool";
import { Config } from "./config";
import { ProjectConfig } from "./config-types";
import { join, resolve } from "path";

export class Project {
    data: ProjectConfig;
    id: ProjectId;

    pool: WorkspacePool = null as any;
    tokenManager: TokenManager = null as any;
    constructor(
        data: ProjectConfig,
        id: ProjectId,
        private config: Config
    ) {
        this.data = data;
        this.id = id;
    }

    initialize() {
        const projectDir = join(
            this.config.server.workspaceDir,
            "projects",
            this.id
        );
        const pool = new WorkspacePool(
            projectDir,
            this.data.claudeCode.mcpServers,
            this.data.maxConcurrentTasks
        );
        const tokenManager = new TokenManager(this.data.auth, projectDir);

        this.pool = pool;
        this.tokenManager = tokenManager;

        // Rediscover existing workspace directories from disk for each project
        pool.initFromDisk();
    }
}
