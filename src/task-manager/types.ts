import type { WorkspacePool } from "../workspace-pool.js";
import type { TokenManager } from "../auth.js";
import type { ProjectConfig } from "../config/config-types.js";
import type { Task } from "../types.js";
import type { Executor } from "../executor.js";

export interface ProjectState {
    config: ProjectConfig;
    pool: WorkspacePool;
    tokenManager: TokenManager;
}

export interface TaskEntry {
    task: Task;
    executor: Executor | null;
    workspaceId: number | null;
    /** Branch to check out when this task is dequeued (used for retried tasks). */
    checkoutBranch?: string;
    /** True when this task was just resumed after a server restart. Causes the first post-restart
     *  failure to retry immediately (delay=0) instead of waiting the full errorRetry.delaySeconds. */
    resumedFromRestart?: boolean;
    /** True when cancelTask() was called on a running task. Prevents executeTask from overwriting cancelled status. */
    cancelled?: boolean;
    /** setTimeout handle for scheduled retries — cleared on cancelTask to abort pending retry. */
    retryTimeoutId?: ReturnType<typeof setTimeout>;
}
