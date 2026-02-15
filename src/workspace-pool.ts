import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitManager } from "./git-manager.js";
import type { McpServerConfig, RepositoryConfig } from "./types.js";

const SANDBOX_UID = "1000";

export function chownRecursive(dir: string): Promise<void> {
  return new Promise((resolve) => {
    execFile("chown", ["-R", `${SANDBOX_UID}:${SANDBOX_UID}`, dir], (error) => {
      // Ignore errors — chown is only needed when running as root in Docker
      resolve();
    });
  });
}

const DEFAULT_MAX_CONCURRENT_TASKS = 4;

interface WorkspaceInstance {
  dir: string;
  inUse: boolean;
}

export class PoolExhaustedError extends Error {
  constructor(maxConcurrentTasks: number) {
    super(`Maximum concurrent tasks reached (${maxConcurrentTasks})`);
    this.name = "PoolExhaustedError";
  }
}

export class WorkspacePool {
  private baseDir: string;
  private maxConcurrentTasks: number;
  private instances: Map<number, WorkspaceInstance> = new Map();
  private nextId = 0;
  private gitManager: GitManager;
  private mcpServers?: Record<string, McpServerConfig>;

  constructor(workspaceDir: string, mcpServers?: Record<string, McpServerConfig>, maxConcurrentTasks?: number) {
    this.baseDir = join(workspaceDir, "instances");
    this.maxConcurrentTasks = maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
    this.gitManager = new GitManager();
    this.mcpServers = mcpServers;
  }

  /**
   * Write a CLAUDE.md file in the workspace root so Claude Code knows
   * to work inside the repo directories and not create new git repos.
   */
  private writeClaude(dir: string, repos: RepositoryConfig[]): void {
    const repoList = repos.map((r) => `- ${r.name}/`).join("\n");
    const content = `# Workspace

This workspace contains the following git repositories:
${repoList}

RULES:
- Always \`cd\` into a repository directory before doing any work.
- NEVER run \`git init\`. The repositories are already set up.
- Make all file changes inside a repository directory.
- Commit your changes with \`git commit\` inside the repository. Do NOT push.
`;
    writeFileSync(join(dir, "CLAUDE.md"), content);
  }

  /**
   * Write .mcp.json and .claude/settings.json so Claude Code inside the
   * container discovers the configured MCP servers automatically.
   */
  private writeMcpConfig(dir: string): void {
    if (!this.mcpServers || Object.keys(this.mcpServers).length === 0) {
      return;
    }

    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: this.mcpServers }, null, 2),
    );

    const claudeDir = join(dir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ enableAllProjectMcpServers: true }, null, 2),
    );
  }

  /**
   * Scan the instances/ directory on disk and register existing workspace dirs.
   * Sets nextId to avoid collisions with existing workspaces.
   */
  initFromDisk(): void {
    if (!existsSync(this.baseDir)) {
      return;
    }

    const entries = readdirSync(this.baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = parseInt(entry.name, 10);
      if (isNaN(id)) continue;

      const dir = join(this.baseDir, entry.name);
      this.instances.set(id, { dir, inUse: false });
      console.log(`[pool] Discovered existing workspace instance ${id}`);

      if (id >= this.nextId) {
        this.nextId = id + 1;
      }
    }
  }

  /**
   * Acquire a specific workspace by ID without resetting git state (for resumption).
   * Only rewrites CLAUDE.md and MCP config.
   */
  async acquireExisting(id: number, repos: RepositoryConfig[]): Promise<{ id: number; dir: string }> {
    const instance = this.instances.get(id);
    if (!instance) {
      throw new Error(`Workspace instance ${id} not found`);
    }
    if (instance.inUse) {
      throw new Error(`Workspace instance ${id} is already in use`);
    }

    instance.inUse = true;
    // Remove stray .git that Claude Code may have created at the instance root
    rmSync(join(instance.dir, ".git"), { recursive: true, force: true });
    this.writeClaude(instance.dir, repos);
    this.writeMcpConfig(instance.dir);
    await chownRecursive(instance.dir);
    console.log(`[pool] Acquired existing workspace instance ${id} for resumption`);
    return { id, dir: instance.dir };
  }

  /**
   * Acquire a workspace instance. Reuses a free instance (reset to default branch)
   * or creates a new one by cloning all repos. Throws PoolExhaustedError if the
   * maximum number of concurrent tasks is reached.
   */
  async acquire(repos: RepositoryConfig[]): Promise<{ id: number; dir: string }> {
    // Look for a free instance
    for (const [id, instance] of this.instances) {
      if (!instance.inUse) {
        console.log(`[pool] Reusing workspace instance ${id}`);
        instance.inUse = true;
        // Remove stray .git that Claude Code may have created at the instance root
        rmSync(join(instance.dir, ".git"), { recursive: true, force: true });
        await this.gitManager.ensureAllRepos(instance.dir, repos);
        await this.gitManager.resetToDefaultAll(instance.dir, repos);
        this.writeClaude(instance.dir, repos);
        this.writeMcpConfig(instance.dir);
        await chownRecursive(instance.dir);
        return { id, dir: instance.dir };
      }
    }

    // Check concurrency limit before creating a new instance
    const inUseCount = Array.from(this.instances.values()).filter((i) => i.inUse).length;
    if (inUseCount >= this.maxConcurrentTasks) {
      throw new PoolExhaustedError(this.maxConcurrentTasks);
    }

    // No free instance — create a new one
    const id = this.nextId++;
    const dir = join(this.baseDir, String(id));
    console.log(`[pool] Creating new workspace instance ${id} at ${dir}`);

    this.instances.set(id, { dir, inUse: true });
    await this.gitManager.ensureAllRepos(dir, repos);
    this.writeClaude(dir, repos);
    this.writeMcpConfig(dir);
    await chownRecursive(dir);

    return { id, dir };
  }

  /**
   * Release a workspace instance back to the pool.
   */
  release(id: number): void {
    const instance = this.instances.get(id);
    if (instance) {
      instance.inUse = false;
      console.log(`[pool] Released workspace instance ${id}`);
    }
  }
}
