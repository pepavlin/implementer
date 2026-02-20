import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedTask } from "./types.js";

export class TaskStore {
  private dir: string;

  constructor(workspaceDir: string) {
    this.dir = join(workspaceDir, "tasks");
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Persist a task to disk. Uses write-to-temp-then-rename for atomicity —
   * rename is atomic on POSIX, so a crash mid-write can't produce a
   * half-written JSON file.
   */
  save(task: PersistedTask): void {
    const filePath = join(this.dir, `${task.taskId}.json`);
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(task, null, 2));
    renameSync(tmpPath, filePath);
  }

  /**
   * Load all persisted tasks from disk. Skips corrupted files.
   */
  loadAll(): PersistedTask[] {
    const tasks: PersistedTask[] = [];

    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return tasks;
    }

    for (const file of files) {
      try {
        const raw = readFileSync(join(this.dir, file), "utf-8");
        const task = JSON.parse(raw) as PersistedTask;
        if (task.taskId && typeof task.workspaceId === "number" && task.projectId) {
          tasks.push(task);
        }
      } catch (err) {
        console.warn(`[task-store] Skipping corrupted task file ${file}:`, err);
      }
    }

    return tasks;
  }
}
