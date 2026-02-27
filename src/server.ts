import express from "express";
import type { Request, Response, NextFunction } from "express";
import swaggerUi from "swagger-ui-express";
import { z } from "zod";
import { TaskManager } from "./task-manager/task-manager.js";
import { extractLastAssistantMessage } from "./executor.js";
import { openApiSpec } from "./openapi.js";
import { registerDashboardRoutes } from "./dashboard.js";
import {
    BadRequestError,
    HttpError,
    NotFoundError,
    UnauthorizedError,
    asyncRoute
} from "./errors.js";
import type { ChainId, ProjectId, TaskId, TaskStatus } from "./types.js";
import { Config } from "./config/config.js";

const TaskCreateSchema = z.object({
    prompt: z.string().min(1),
    continueTaskId: z.string().min(1).optional(),
    callbackUrl: z.string().url().optional()
});

const TASK_STATUSES = [
    "queued",
    "starting",
    "running",
    "retrying",
    "completed",
    "failed",
    "interrupted",
    "cancelled"
] as const;

const TaskStatusEnum = z.enum(TASK_STATUSES);

const TaskListQuerySchema = z.object({
    status: z.union([TaskStatusEnum, z.array(TaskStatusEnum)]).optional(),
    chainId: z.string().optional()
});

const MAX_LOG_SIZE = 1024 * 1024; // 1MB

function getDurationSeconds(task: {
    startedAt: string;
    completedAt: string | null;
}): number {
    const start = new Date(task.startedAt).getTime();
    const end = task.completedAt
        ? new Date(task.completedAt).getTime()
        : Date.now();
    return Math.round((end - start) / 1000);
}

function getProjectId(res: any): ProjectId {
    return res.locals.projectId as ProjectId;
}

export function createServer(
    taskManager: TaskManager,
    config: Config
): express.Express {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    // 1. Server swagger ui
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));

    // 2. Admin dashboard html
    registerDashboardRoutes(app, taskManager, config);

    // 3. Add authentication middleware
    app.use((req, res, next) => {
        // Ignore auth for docs and dashboard routes
        if (req.path.startsWith("/docs") || req.path.startsWith("/dashboard"))
            return next();

        const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
        const projectId = config.getProjectIdByToken(token);
        if (!projectId) {
            throw new UnauthorizedError(
                "Project not found for the provided API key"
            );
        }
        res.locals.projectId = projectId as ProjectId;
        next();
    });

    // GET / - redirect to docs
    app.get("/", (_req, res) => {
        res.redirect("/docs");
    });

    // POST /task - Start a new task
    app.post(
        "/task",
        asyncRoute(async (req, res) => {
            const parsed = TaskCreateSchema.safeParse(req.body);
            if (!parsed.success) {
                throw new BadRequestError(
                    "Invalid request",
                    parsed.error.issues
                );
            }
            const task = await taskManager.startTask(
                getProjectId(res),
                {
                    ...parsed.data,
                    continueTaskId: parsed.data.continueTaskId as TaskId | undefined
                }
            );
            res.status(200).json({
                taskId: task.taskId,
                branch: task.branch,
                status: task.status,
                parentTaskId: task.parentTaskId ?? null,
                chainId: task.chainId ?? null
            });
        })
    );

    // GET /tasks - List all tasks for the authenticated project
    app.get("/tasks", (req, res) => {
        const parsed = TaskListQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            throw new BadRequestError("Invalid status value");
        }
        const statusFilter = parsed.data.status
            ? new Set<TaskStatus>(
                  Array.isArray(parsed.data.status)
                      ? parsed.data.status
                      : [parsed.data.status]
              )
            : null;
        const chainId = parsed.data.chainId as ChainId | undefined;
        const tasks = taskManager
            .listTasks(getProjectId(res), chainId ? { chainId } : undefined)
            .filter((task) => !statusFilter || statusFilter.has(task.status))
            .map((task) => ({
                taskId: task.taskId,
                branch: task.branch,
                prompt: task.prompt,
                title: task.title ?? null,
                parentTaskId: task.parentTaskId ?? null,
                chainId: task.chainId ?? null,
                status: task.status,
                startedAt: task.startedAt,
                completedAt: task.completedAt,
                durationSeconds: getDurationSeconds(task),
                pullRequests: task.pullRequests ?? null
            }));
        res.json({ tasks });
    });

    // GET /task/:taskId - Get specific task status
    app.get("/task/:taskId", (req, res) => {
        const task = taskManager.getTask(getProjectId(res), req.params.taskId as TaskId);
        if (!task) throw new NotFoundError("Task not found");
        res.json({
            taskId: task.taskId,
            branch: task.branch,
            prompt: task.prompt,
            title: task.title ?? null,
            parentTaskId: task.parentTaskId ?? null,
            chainId: task.chainId ?? null,
            status: task.status,
            attempt: task.attempt,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            durationSeconds: getDurationSeconds(task),
            output:
                task.status === "queued" ||
                task.status === "starting" ||
                task.status === "running" ||
                task.status === "retrying" ||
                task.status === "interrupted"
                    ? null
                    : extractLastAssistantMessage(task.output) || null,
            error: task.error ?? null,
            pullRequests: task.pullRequests ?? null
        });
    });

    // POST /task/:taskId/cancel - Cancel a queued, running, or retrying task
    app.post("/task/:taskId/cancel", (req, res) => {
        const taskId = req.params.taskId as TaskId;
        const task = taskManager.getTask(getProjectId(res), taskId);
        if (!task) throw new NotFoundError("Task not found");
        const cancelled = taskManager.cancelTask(
            getProjectId(res),
            taskId
        );
        res.json({
            taskId: cancelled.taskId,
            branch: cancelled.branch,
            status: cancelled.status
        });
    });

    // POST /task/:taskId/retry - Retry a task regardless of its current status
    app.post(
        "/task/:taskId/retry",
        asyncRoute(async (req, res) => {
            const projectId = res.locals.projectId as ProjectId;
            const taskId = req.params.taskId as TaskId;
            const task = taskManager.getTask(projectId, taskId);
            if (!task) throw new NotFoundError("Task not found");
            const retried = await taskManager.retryTask(
                projectId,
                taskId
            );
            res.json({
                taskId: retried.taskId,
                branch: retried.branch,
                status: retried.status
            });
        })
    );

    // GET /task/:taskId/log - Get specific task output log
    app.get("/task/:taskId/log", (req, res) => {
        const projectId = res.locals.projectId as ProjectId;
        const taskId = req.params.taskId as TaskId;
        const task = taskManager.getTask(projectId, taskId);
        if (!task) throw new NotFoundError("Task not found");
        const fullOutput = taskManager.getOutput(projectId, taskId);
        const truncated = fullOutput.length > MAX_LOG_SIZE;
        res.json({
            taskId: task.taskId,
            output: truncated ? fullOutput.slice(-MAX_LOG_SIZE) : fullOutput,
            truncated
        });
    });

    // Central error handler — must be declared with 4 params for Express to
    app.use(
        (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
            if (err instanceof HttpError) {
                const body: Record<string, unknown> = { error: err.message };
                if (err.details !== undefined) body.details = err.details;
                res.status(err.statusCode).json(body);
                return;
            }
            res.status(500).json({
                error:
                    err instanceof Error ? err.message : "Internal server error"
            });
        }
    );

    return app;
}
