import express from "express";
import type { Request, Response, NextFunction } from "express";
import swaggerUi from "swagger-ui-express";
import { z } from "zod";
import { TaskManager } from "./task-manager/task-manager.js";
import { extractLastAssistantMessage } from "./executor.js";
import { openApiSpec } from "./openapi.js";
import { registerDashboardRoutes, isDashboardAuthenticated } from "./dashboard.js";
import {
    BadRequestError,
    HttpError,
    NotFoundError,
    UnauthorizedError,
    asyncRoute
} from "./errors.js";
import type { ChainId, ProjectId, TaskId, TaskStatus } from "./types.js";
import { Config } from "./config/config.js";
import type { Task } from "./task-manager/task.js";

const TASK_PRIORITIES = ["low", "normal", "high", "critical"] as const;

const TaskCreateSchema = z.object({
    prompt: z.string().min(1),
    continueTaskId: z.string().min(1).optional(),
    callbackUrl: z.string().url().optional(),
    priority: z.enum(TASK_PRIORITIES).optional()
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

function getDurationSeconds(task: Task): number {
    const start = new Date(
        task.data.startedAt ?? task.data.createdAt
    ).getTime();
    const end = task.data.completedAt
        ? new Date(task.data.completedAt).getTime()
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
        // Ignore auth for docs, dashboard, and root routes
        if (
            req.path === "/" ||
            req.path.startsWith("/docs") ||
            req.path.startsWith("/dashboard")
        )
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

    // GET / - redirect to /dashboard if admin is authenticated, otherwise 404
    app.get("/", (req, res) => {
        const adminPassword = config.server.adminPassword;
        if (adminPassword && isDashboardAuthenticated(req, adminPassword)) {
            res.redirect("/dashboard");
        } else {
            res.status(404).json({ error: "Not found" });
        }
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
            const task = taskManager.createNewTask(getProjectId(res), {
                ...parsed.data,
                continueTaskId: parsed.data.continueTaskId as TaskId | undefined,
                priority: parsed.data.priority
            });
            res.status(200).json({
                taskId: task.id,
                branch: task.branch,
                status: task.data.status,
                parentTaskId: task.data.parentTaskId ?? null,
                chainId: task.data.chainId ?? null
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
            .filter(
                (task) => !statusFilter || statusFilter.has(task.data.status)
            )
            .map((task) => ({
                taskId: task.id,
                branch: task.branch,
                prompt: task.data.prompt,
                title: task.title ?? null,
                parentTaskId: task.data.parentTaskId ?? null,
                chainId: task.data.chainId ?? null,
                status: task.data.status,
                createdAt: task.data.createdAt,
                startedAt: task.data.startedAt ?? null,
                completedAt: task.data.completedAt,
                durationSeconds: getDurationSeconds(task),
                pullRequests: task.data.pullRequests ?? null
            }));
        res.json({ tasks });
    });

    // GET /task/:taskId - Get specific task status
    app.get("/task/:taskId", (req, res) => {
        const task = taskManager.getTask(req.params.taskId as TaskId);
        if (!task || task.data.projectId !== getProjectId(res))
            throw new NotFoundError("Task not found");
        res.json({
            taskId: task.id,
            branch: task.branch,
            prompt: task.data.prompt,
            title: task.title ?? null,
            parentTaskId: task.data.parentTaskId ?? null,
            chainId: task.data.chainId ?? null,
            status: task.data.status,
            attempt: task.data.attempt,
            createdAt: task.data.createdAt,
            startedAt: task.data.startedAt ?? null,
            completedAt: task.data.completedAt,
            durationSeconds: getDurationSeconds(task),
            output:
                task.data.status === "queued" ||
                task.data.status === "starting" ||
                task.data.status === "running" ||
                task.data.status === "retrying" ||
                task.data.status === "interrupted"
                    ? null
                    : extractLastAssistantMessage(task.data.output) || null,
            error: task.data.error ?? null,
            pullRequests: task.data.pullRequests ?? null
        });
    });

    // POST /task/:taskId/cancel - Cancel a queued, running, or retrying task
    app.post(
        "/task/:taskId/cancel",
        asyncRoute(async (req, res) => {
            const taskId = req.params.taskId as TaskId;
            const task = taskManager.getTask(taskId);
            if (!task || task.data.projectId !== getProjectId(res))
                throw new NotFoundError("Task not found");
            const cancelled = await taskManager.cancelTask(
                getProjectId(res),
                taskId
            );
            res.json({
                taskId: cancelled.id,
                branch: cancelled.branch,
                status: cancelled.data.status
            });
        })
    );

    // POST /task/:taskId/retry - Retry a task regardless of its current status
    app.post(
        "/task/:taskId/retry",
        asyncRoute(async (req, res) => {
            const projectId = getProjectId(res);
            const taskId = req.params.taskId as TaskId;
            const task = taskManager.getTask(taskId);
            if (!task || task.data.projectId !== projectId)
                throw new NotFoundError("Task not found");
            const retried = taskManager.retryTask(projectId, taskId);
            res.json({
                taskId: retried.id,
                branch: retried.branch,
                status: retried.data.status
            });
        })
    );

    // GET /task/:taskId/log - Get specific task output log
    app.get("/task/:taskId/log", (req, res) => {
        const projectId = getProjectId(res);
        const taskId = req.params.taskId as TaskId;
        const task = taskManager.getTask(taskId);
        if (!task || task.data.projectId !== projectId)
            throw new NotFoundError("Task not found");
        const fullOutput = taskManager.getOutput(taskId);
        const truncated = fullOutput.length > MAX_LOG_SIZE;
        res.json({
            taskId: task.id,
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
