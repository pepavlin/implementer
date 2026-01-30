import express from "express";
import { z } from "zod";
import { TaskManager, TaskBusyError } from "./task-manager.js";
import type { Config } from "./types.js";

const TaskCreateSchema = z.object({
  repository: z.string().min(1),
  prompt: z.string().min(1),
  fromBranch: z.string().optional(),
});

const MAX_LOG_SIZE = 1024 * 1024; // 1MB

export function createServer(config: Config, taskManager: TaskManager): express.Express {
  const app = express();
  app.use(express.json());

  // POST /task - Start a new task
  app.post("/task", async (req, res) => {
    const parsed = TaskCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.issues,
      });
      return;
    }

    const request = parsed.data;

    // Validate repository exists in config
    if (!taskManager.findRepository(request.repository)) {
      res.status(400).json({
        error: `Repository "${request.repository}" not found in config`,
      });
      return;
    }

    try {
      const task = await taskManager.startTask(request);
      res.status(200).json({
        taskId: task.taskId,
        repository: task.repository,
        branch: task.branch,
        status: task.status,
      });
    } catch (err) {
      if (err instanceof TaskBusyError) {
        res.status(409).json({
          error: "Task already running",
          currentTask: {
            taskId: err.currentTask.taskId,
            status: err.currentTask.status,
          },
        });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : "Internal server error",
      });
    }
  });

  // GET /task/status - Get current task status
  app.get("/task/status", (_req, res) => {
    const currentTask = taskManager.getCurrentTask();

    if (currentTask) {
      res.json({
        taskId: currentTask.taskId,
        repository: currentTask.repository,
        branch: currentTask.branch,
        prompt: currentTask.prompt,
        status: currentTask.status,
        startedAt: currentTask.startedAt,
        completedAt: currentTask.completedAt,
      });
      return;
    }

    const lastTask = taskManager.getLastTask();
    res.json({
      status: "idle" as const,
      lastTask: lastTask
        ? {
            taskId: lastTask.taskId,
            repository: lastTask.repository,
            branch: lastTask.branch,
            prompt: lastTask.prompt,
            status: lastTask.status,
            startedAt: lastTask.startedAt,
            completedAt: lastTask.completedAt,
          }
        : null,
    });
  });

  // GET /task/log - Get task output log
  app.get("/task/log", (_req, res) => {
    const taskId = taskManager.getActiveTaskId() ?? taskManager.getLastTask()?.taskId;

    if (!taskId) {
      res.status(404).json({ error: "No task found" });
      return;
    }

    const fullOutput = taskManager.getOutput();
    const truncated = fullOutput.length > MAX_LOG_SIZE;
    const output = truncated ? fullOutput.slice(-MAX_LOG_SIZE) : fullOutput;

    res.json({
      taskId,
      output,
      truncated,
    });
  });

  return app;
}
