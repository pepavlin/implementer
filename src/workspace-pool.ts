import { join } from "node:path";
import { GitManager } from "./git-manager.js";
import type { RepositoryConfig } from "./types.js";

const MAX_CONCURRENT_TASKS = 5;

interface WorkspaceInstance {
  dir: string;
  inUse: boolean;
}

export class PoolExhaustedError extends Error {
  constructor() {
    super(`Maximum concurrent tasks reached (${MAX_CONCURRENT_TASKS})`);
    this.name = "PoolExhaustedError";
  }
}

export class WorkspacePool {
  private baseDir: string;
  private instances: Map<number, WorkspaceInstance> = new Map();
  private nextId = 0;
  private gitManager: GitManager;

  constructor(workspaceDir: string) {
    this.baseDir = join(workspaceDir, "instances");
    this.gitManager = new GitManager();
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
        await this.gitManager.resetToDefaultAll(instance.dir, repos);
        return { id, dir: instance.dir };
      }
    }

    // Check concurrency limit before creating a new instance
    const inUseCount = Array.from(this.instances.values()).filter((i) => i.inUse).length;
    if (inUseCount >= MAX_CONCURRENT_TASKS) {
      throw new PoolExhaustedError();
    }

    // No free instance — create a new one
    const id = this.nextId++;
    const dir = join(this.baseDir, String(id));
    console.log(`[pool] Creating new workspace instance ${id} at ${dir}`);

    this.instances.set(id, { dir, inUse: true });
    await this.gitManager.ensureAllRepos(dir, repos);

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
