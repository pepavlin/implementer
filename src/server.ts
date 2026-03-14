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
import {
    verifyWebhookSignature,
    shouldTriggerPoll,
    extractRepoInfo,
    SUPPORTED_EVENTS,
    type WebhookPayload
} from "./webhook-handler.js";

const TASK_PRIORITIES = ["low", "normal", "high", "critical"] as const;

const TaskCreateSchema = z.object({
    prompt: z.string().min(1),
    continueTaskId: z.string().min(1).optional(),
    callbackUrl: z.string().url().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    repoUrl: z.string().url().optional(),
    githubToken: z.string().min(1).optional()
});

const TASK_STATUSES = [
    "queued",
    "starting",
    "running",
    "retrying",
    "waiting_for_pipeline",
    "completed",
    "failed",
    "interrupted",
    "cancelled"
] as const;

const TaskStatusEnum = z.enum(TASK_STATUSES);

const TaskListQuerySchema = z.object({
    status: z.union([TaskStatusEnum, z.array(TaskStatusEnum)]).optional(),
    chainId: z.string().optional(),
    repoUrl: z.string().optional()
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
    app.use(
        express.json({
            // Store raw body buffer for webhook signature verification
            verify: (req: express.Request, _res, buf) => {
                (req as any).rawBody = buf;
            }
        })
    );
    app.use(express.urlencoded({ extended: false }));

    // 1. Server swagger ui
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));

    // 2. Admin dashboard html
    registerDashboardRoutes(app, taskManager, config);

    // 3. Add authentication middleware
    app.use((req, res, next) => {
        // Ignore auth for docs, dashboard, root, and webhook routes
        // (webhooks use their own signature-based auth)
        if (
            req.path === "/" ||
            req.path.startsWith("/docs") ||
            req.path.startsWith("/dashboard") ||
            req.path.startsWith("/webhook/")
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
                priority: parsed.data.priority,
                repoUrl: parsed.data.repoUrl,
                githubToken: parsed.data.githubToken
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
        const repoUrl = parsed.data.repoUrl;
        const baseTasks = repoUrl
            ? taskManager.listTasksByRepoUrl(repoUrl)
            : taskManager.listTasks(getProjectId(res), chainId ? { chainId } : undefined);
        const tasks = baseTasks
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

    // POST /webhook/github - Unified GitHub webhook endpoint (auto-routes by repo)
    app.post(
        "/webhook/github",
        asyncRoute(async (req, res) => {
            const webhookSecret = config.server.webhookSecret;
            if (!webhookSecret) {
                throw new BadRequestError(
                    "Unified webhook is not configured (no server.webhookSecret)"
                );
            }

            // Verify HMAC SHA-256 signature using the global secret
            const signatureHeader = req.headers["x-hub-signature-256"] as
                | string
                | undefined;
            const rawBody = (req as any).rawBody as Buffer | undefined;

            if (!rawBody) {
                throw new BadRequestError("Missing request body");
            }

            if (
                !verifyWebhookSignature(rawBody, webhookSecret, signatureHeader)
            ) {
                throw new UnauthorizedError("Invalid webhook signature");
            }

            // Determine event type
            const event = req.headers["x-github-event"] as string | undefined;
            if (!event) {
                throw new BadRequestError("Missing X-GitHub-Event header");
            }

            const deliveryId = req.headers["x-github-delivery"] as
                | string
                | undefined;

            const payload = req.body as WebhookPayload;

            // Extract repo info and find matching project
            const repoInfo = extractRepoInfo(payload);
            if (!repoInfo) {
                res.status(200).json({
                    accepted: false,
                    reason: "No repository information in payload"
                });
                return;
            }

            const projectId = config.findProjectByRepo(
                repoInfo.fullName,
                repoInfo.htmlUrl
            );
            if (!projectId) {
                const repoLabel =
                    repoInfo.fullName ?? repoInfo.htmlUrl ?? "unknown";
                console.log(
                    `[webhook] No project found for repository "${repoLabel}"` +
                        (deliveryId ? ` (delivery: ${deliveryId})` : "")
                );
                res.status(200).json({
                    accepted: false,
                    reason: `No project configured for repository ${repoLabel}`
                });
                return;
            }

            const project = config.projects[projectId];
            const projectRepoUrls = project.data.repositories.map(
                (r) => r.url
            );
            const filterResult = shouldTriggerPoll(
                event,
                payload,
                projectRepoUrls
            );

            if (!filterResult.shouldPoll) {
                console.log(
                    `[webhook] Ignored event for project "${projectId}": ${filterResult.reason}` +
                        (deliveryId ? ` (delivery: ${deliveryId})` : "")
                );
                res.status(200).json({
                    accepted: false,
                    projectId,
                    reason: filterResult.reason
                });
                return;
            }

            console.log(
                `[webhook] Accepted event for project "${projectId}": ${filterResult.reason}` +
                    (deliveryId ? ` (delivery: ${deliveryId})` : "")
            );

            // Trigger immediate poll in the background (don't block the response)
            taskManager.triggerProjectPoll(projectId).catch((err) => {
                console.error(
                    `[webhook] Error during triggered poll for project "${projectId}":`,
                    err instanceof Error ? err.message : String(err)
                );
            });

            res.status(200).json({
                accepted: true,
                projectId,
                reason: filterResult.reason
            });
        })
    );

    // POST /webhook/github/:projectId - Receive GitHub webhook events (per-project)
    app.post(
        "/webhook/github/:projectId",
        asyncRoute(async (req, res) => {
            const projectId = req.params.projectId as ProjectId;
            const project = config.projects[projectId];

            if (!project) {
                throw new NotFoundError(`Project not found: ${projectId}`);
            }

            const webhookSecret = project.data.webhookSecret;
            if (!webhookSecret) {
                throw new BadRequestError(
                    `Webhooks are not configured for project "${projectId}" (no webhookSecret)`
                );
            }

            // Verify HMAC SHA-256 signature
            const signatureHeader = req.headers["x-hub-signature-256"] as
                | string
                | undefined;
            const rawBody = (req as any).rawBody as Buffer | undefined;

            if (!rawBody) {
                throw new BadRequestError("Missing request body");
            }

            if (
                !verifyWebhookSignature(rawBody, webhookSecret, signatureHeader)
            ) {
                throw new UnauthorizedError("Invalid webhook signature");
            }

            // Determine event type and filter
            const event = req.headers["x-github-event"] as string | undefined;
            if (!event) {
                throw new BadRequestError("Missing X-GitHub-Event header");
            }

            const deliveryId = req.headers["x-github-delivery"] as
                | string
                | undefined;

            const payload = req.body as WebhookPayload;
            const projectRepoUrls = project.data.repositories.map(
                (r) => r.url
            );
            const filterResult = shouldTriggerPoll(
                event,
                payload,
                projectRepoUrls
            );

            if (!filterResult.shouldPoll) {
                console.log(
                    `[webhook] Ignored event for project "${projectId}": ${filterResult.reason}` +
                        (deliveryId ? ` (delivery: ${deliveryId})` : "")
                );
                res.status(200).json({
                    accepted: false,
                    reason: filterResult.reason
                });
                return;
            }

            console.log(
                `[webhook] Accepted event for project "${projectId}": ${filterResult.reason}` +
                    (deliveryId ? ` (delivery: ${deliveryId})` : "")
            );

            // Trigger immediate poll in the background (don't block the response)
            taskManager.triggerProjectPoll(projectId).catch((err) => {
                console.error(
                    `[webhook] Error during triggered poll for project "${projectId}":`,
                    err instanceof Error ? err.message : String(err)
                );
            });

            res.status(200).json({
                accepted: true,
                reason: filterResult.reason
            });
        })
    );

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
