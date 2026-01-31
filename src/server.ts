import express from "express";
import { z } from "zod";
import { TaskManager } from "./task-manager.js";
import { PoolExhaustedError } from "./workspace-pool.js";

const TaskCreateSchema = z.object({
  prompt: z.string().min(1),
  fromBranch: z.string().optional(),
});

const MAX_LOG_SIZE = 1024 * 1024; // 1MB

export function createServer(taskManager: TaskManager): express.Express {
  const app = express();
  app.use(express.json());

  // API key authentication
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    app.use((req, res, next) => {
      const header = req.headers.authorization;
      if (header !== `Bearer ${apiKey}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    });
  }

  // POST /task - Start a new task (always accepts, parallel execution)
  app.post("/task", async (req, res) => {
    const parsed = TaskCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.issues,
      });
      return;
    }

    try {
      const task = await taskManager.startTask(parsed.data);
      res.status(200).json({
        taskId: task.taskId,
        branch: task.branch,
        status: task.status,
      });
    } catch (err) {
      if (err instanceof PoolExhaustedError) {
        res.status(429).json({ error: err.message });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : "Internal server error",
      });
    }
  });

  // GET /tasks - List all tasks
  app.get("/tasks", (_req, res) => {
    const tasks = taskManager.listTasks().map((task) => ({
      taskId: task.taskId,
      branch: task.branch,
      prompt: task.prompt,
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    }));
    res.json({ tasks });
  });

  // GET /task/:taskId - Get specific task status
  app.get("/task/:taskId", (req, res) => {
    const task = taskManager.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    res.json({
      taskId: task.taskId,
      branch: task.branch,
      prompt: task.prompt,
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      error: task.error,
    });
  });

  // GET /task/:taskId/log - Get specific task output log
  app.get("/task/:taskId/log", (req, res) => {
    const task = taskManager.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const fullOutput = taskManager.getOutput(req.params.taskId);
    const truncated = fullOutput.length > MAX_LOG_SIZE;
    const output = truncated ? fullOutput.slice(-MAX_LOG_SIZE) : fullOutput;

    res.json({
      taskId: task.taskId,
      output,
      truncated,
    });
  });

  return app;
}
