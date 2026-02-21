import express from "express";
import swaggerUi from "swagger-ui-express";
import { z } from "zod";
import { TaskManager, TaskActiveError } from "./task-manager.js";
import { UsageLimitError } from "./usage-limiter.js";
import { extractLastAssistantMessage } from "./executor.js";
import type { Config, TaskStatus } from "./types.js";

const TaskCreateSchema = z.object({
    prompt: z.string().min(1),
    fromBranch: z.string().optional(),
    callbackUrl: z.string().url().optional()
});

const TASK_STATUSES = ["queued", "running", "retrying", "completed", "failed", "interrupted"] as const;

const TaskStatusEnum = z.enum(TASK_STATUSES);

const TaskListQuerySchema = z.object({
    status: z.union([TaskStatusEnum, z.array(TaskStatusEnum)]).optional()
});

const MAX_LOG_SIZE = 1024 * 1024; // 1MB

const openApiSpec = {
    openapi: "3.0.3",
    info: {
        title: "Implementer",
        description:
            "AI Code Task Execution Service — receives coding tasks via REST API, executes them using Claude Code CLI in isolated Docker sandboxes.",
        version: "1.0.0"
    },
    servers: [{ url: "/" }],
    security: [{ BearerAuth: [] }],
    components: {
        securitySchemes: {
            BearerAuth: {
                type: "http",
                scheme: "bearer"
            }
        },
        schemas: {
            TaskCreateRequest: {
                type: "object",
                required: ["prompt"],
                properties: {
                    prompt: {
                        type: "string",
                        description: "What to implement",
                        example: "Add a dark mode toggle to the navbar"
                    },
                    fromBranch: {
                        type: "string",
                        description:
                            "Continue from an existing branch instead of creating a new one",
                        example: "impl/dark-mode-abc123"
                    },
                    callbackUrl: {
                        type: "string",
                        format: "uri",
                        description:
                            "URL to POST to when the task finishes. Body: { taskId, status }",
                        example: "https://example.com/webhook/task-done"
                    }
                }
            },
            TaskCreateResponse: {
                type: "object",
                properties: {
                    taskId: { type: "string", example: "TVchAThD" },
                    branch: {
                        type: "string",
                        nullable: true,
                        description:
                            "Branch name. Null until generated asynchronously — poll GET /task/{taskId} to get the final branch.",
                        example: null
                    },
                    status: {
                        type: "string",
                        enum: ["queued"],
                        example: "queued"
                    }
                }
            },
            PullRequest: {
                type: "object",
                properties: {
                    repo: { type: "string", example: "my-repo" },
                    url: {
                        type: "string",
                        example: "https://github.com/org/repo/pull/42"
                    }
                }
            },
            TaskStatus: {
                type: "object",
                properties: {
                    taskId: { type: "string" },
                    branch: { type: "string", nullable: true },
                    prompt: { type: "string" },
                    status: {
                        type: "string",
                        enum: ["queued", "running", "retrying", "completed", "failed", "interrupted"]
                    },
                    startedAt: { type: "string", format: "date-time" },
                    completedAt: {
                        type: "string",
                        format: "date-time",
                        nullable: true
                    },
                    durationSeconds: {
                        type: "number",
                        description:
                            "Elapsed time in seconds (running tasks show time so far)"
                    },
                    output: {
                        type: "string",
                        nullable: true,
                        description:
                            "Final response/answer from Claude Code (null while task is running)"
                    },
                    error: { type: "string", nullable: true },
                    pullRequests: {
                        type: "array",
                        items: { $ref: "#/components/schemas/PullRequest" },
                        nullable: true,
                        description: "Pull requests created for this task"
                    }
                }
            },
            TaskLog: {
                type: "object",
                properties: {
                    taskId: { type: "string" },
                    output: {
                        type: "string",
                        description: "Claude Code CLI output"
                    },
                    truncated: {
                        type: "boolean",
                        description: "Whether the output was truncated to 1MB"
                    }
                }
            },
            Error: {
                type: "object",
                properties: {
                    error: { type: "string" }
                }
            }
        }
    },
    paths: {
        "/task": {
            post: {
                summary: "Start a new task",
                description:
                    "Creates a new coding task. The task runs asynchronously in an isolated Docker sandbox with Claude Code. Returns immediately with the task ID and branch name.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                $ref: "#/components/schemas/TaskCreateRequest"
                            }
                        }
                    }
                },
                responses: {
                    "200": {
                        description: "Task started",
                        content: {
                            "application/json": {
                                schema: {
                                    $ref: "#/components/schemas/TaskCreateResponse"
                                }
                            }
                        }
                    },
                    "400": {
                        description: "Invalid request",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/Error" }
                            }
                        }
                    },
                    "401": { description: "Unauthorized" },
                    "429": {
                        description: "Max concurrent tasks reached",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/Error" }
                            }
                        }
                    }
                }
            }
        },
        "/tasks": {
            get: {
                summary: "List all tasks",
                description:
                    "Returns all tasks for the authenticated project (running, completed, and failed). Optionally filter by one or more statuses using the `status` query parameter.",
                parameters: [
                    {
                        name: "status",
                        in: "query",
                        required: false,
                        description:
                            "Filter by task status. Repeat to include multiple statuses (e.g. `?status=running&status=queued`).",
                        schema: {
                            oneOf: [
                                {
                                    type: "string",
                                    enum: ["queued", "running", "retrying", "completed", "failed", "interrupted"]
                                },
                                {
                                    type: "array",
                                    items: {
                                        type: "string",
                                        enum: ["queued", "running", "retrying", "completed", "failed", "interrupted"]
                                    }
                                }
                            ]
                        },
                        style: "form",
                        explode: true
                    }
                ],
                responses: {
                    "200": {
                        description: "Task list",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        tasks: {
                                            type: "array",
                                            items: {
                                                $ref: "#/components/schemas/TaskStatus"
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    "400": {
                        description: "Invalid status value",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/Error" }
                            }
                        }
                    },
                    "401": { description: "Unauthorized" }
                }
            }
        },
        "/task/{taskId}": {
            get: {
                summary: "Get task status",
                description: "Returns the current status of a specific task.",
                parameters: [
                    {
                        name: "taskId",
                        in: "path",
                        required: true,
                        schema: { type: "string" }
                    }
                ],
                responses: {
                    "200": {
                        description: "Task status",
                        content: {
                            "application/json": {
                                schema: {
                                    $ref: "#/components/schemas/TaskStatus"
                                }
                            }
                        }
                    },
                    "401": { description: "Unauthorized" },
                    "404": {
                        description: "Task not found",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/Error" }
                            }
                        }
                    }
                }
            }
        },
        "/task/{taskId}/log": {
            get: {
                summary: "Get task output log",
                description:
                    "Returns the Claude Code CLI output for a task. Output is truncated to 1MB if larger.",
                parameters: [
                    {
                        name: "taskId",
                        in: "path",
                        required: true,
                        schema: { type: "string" }
                    }
                ],
                responses: {
                    "200": {
                        description: "Task log",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/TaskLog" }
                            }
                        }
                    },
                    "401": { description: "Unauthorized" },
                    "404": {
                        description: "Task not found",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/Error" }
                            }
                        }
                    }
                }
            }
        },
        "/task/{taskId}/retry": {
            post: {
                summary: "Retry a task",
                description:
                    "Re-runs an existing task regardless of its current status (completed, failed, interrupted). The task is re-executed on the same branch so Claude can see previous work. Returns 409 if the task is currently active (queued, running, or retrying).",
                parameters: [
                    {
                        name: "taskId",
                        in: "path",
                        required: true,
                        schema: { type: "string" }
                    }
                ],
                responses: {
                    "200": {
                        description: "Task retried",
                        content: {
                            "application/json": {
                                schema: {
                                    $ref: "#/components/schemas/TaskCreateResponse"
                                }
                            }
                        }
                    },
                    "401": { description: "Unauthorized" },
                    "404": {
                        description: "Task not found",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/Error" }
                            }
                        }
                    },
                    "409": {
                        description: "Task is currently active and cannot be retried",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/Error" }
                            }
                        }
                    }
                }
            }
        }
    }
};

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

export function createServer(
    taskManager: TaskManager,
    config: Config
): express.Express {
    const app = express();
    app.use(express.json());

    // Swagger UI — served before auth so it's accessible without a key
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));

    // Build Bearer token → projectId map from config
    const projectByKey = new Map<string, string>();
    for (const [projectId, project] of Object.entries(config.projects)) {
        if (project.apiKey) {
            projectByKey.set(project.apiKey, projectId);
        }
    }

    const projectIds = Object.keys(config.projects);
    const hasAuth = projectByKey.size > 0;

    // Authentication middleware: maps Bearer token to a project
    app.use((req, res, next) => {
        // Swagger UI is always accessible
        if (req.path.startsWith("/docs")) return next();

        if (!hasAuth) {
            // Dev mode: no API keys configured — require exactly one project
            if (projectIds.length === 1) {
                res.locals.projectId = projectIds[0];
                return next();
            }
            res.status(401).json({
                error: "API key required when multiple projects are configured without apiKey"
            });
            return;
        }

        const token = req.headers.authorization?.replace("Bearer ", "");
        const projectId = projectByKey.get(token ?? "");
        if (!projectId) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        res.locals.projectId = projectId;
        next();
    });

    // GET / - redirect to docs
    app.get("/", (_req, res) => {
        res.redirect("/docs");
    });

    // POST /task - Start a new task
    app.post("/task", async (req, res) => {
        const projectId = res.locals.projectId as string;
        const parsed = TaskCreateSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({
                error: "Invalid request",
                details: parsed.error.issues
            });
            return;
        }

        try {
            const task = await taskManager.startTask(projectId, parsed.data);
            res.status(200).json({
                taskId: task.taskId,
                branch: task.branch,
                status: task.status
            });
        } catch (err) {
            if (err instanceof UsageLimitError) {
                res.status(429).json({ error: err.message });
                return;
            }
            res.status(500).json({
                error:
                    err instanceof Error ? err.message : "Internal server error"
            });
        }
    });

    // GET /tasks - List all tasks for the authenticated project
    app.get("/tasks", (req, res) => {
        const projectId = res.locals.projectId as string;

        const parsed = TaskListQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            res.status(400).json({ error: "Invalid status value" });
            return;
        }

        const statusFilter = parsed.data.status
            ? new Set<TaskStatus>(
                  Array.isArray(parsed.data.status)
                      ? parsed.data.status
                      : [parsed.data.status]
              )
            : null;

        const tasks = taskManager
            .listTasks(projectId)
            .filter((task) => !statusFilter || statusFilter.has(task.status))
            .map((task) => ({
                taskId: task.taskId,
                branch: task.branch,
                prompt: task.prompt,
                status: task.status,
                startedAt: task.startedAt,
                completedAt: task.completedAt,
                durationSeconds: getDurationSeconds(task)
            }));
        res.json({ tasks });
    });

    // GET /task/:taskId - Get specific task status
    app.get("/task/:taskId", (req, res) => {
        const projectId = res.locals.projectId as string;
        const task = taskManager.getTask(projectId, req.params.taskId);
        if (!task) {
            res.status(404).json({ error: "Task not found" });
            return;
        }

        res.json({
            taskId: task.taskId,
            branch: task.branch,
            prompt: task.prompt,
            status: task.status,
            attempt: task.attempt,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            durationSeconds: getDurationSeconds(task),
            output:
                task.status === "queued" || task.status === "running" || task.status === "retrying" || task.status === "interrupted"
                    ? null
                    : extractLastAssistantMessage(task.output) || null,
            error: task.error ?? null,
            pullRequests: task.pullRequests ?? null
        });
    });

    // POST /task/:taskId/retry - Retry a task regardless of its current status
    app.post("/task/:taskId/retry", async (req, res) => {
        const projectId = res.locals.projectId as string;
        const task = taskManager.getTask(projectId, req.params.taskId);
        if (!task) {
            res.status(404).json({ error: "Task not found" });
            return;
        }

        try {
            const retried = await taskManager.retryTask(projectId, req.params.taskId);
            res.json({
                taskId: retried.taskId,
                branch: retried.branch,
                status: retried.status
            });
        } catch (err) {
            if (err instanceof TaskActiveError) {
                res.status(409).json({ error: err.message });
                return;
            }
            res.status(500).json({
                error: err instanceof Error ? err.message : "Internal server error"
            });
        }
    });

    // GET /task/:taskId/log - Get specific task output log
    app.get("/task/:taskId/log", (req, res) => {
        const projectId = res.locals.projectId as string;
        const task = taskManager.getTask(projectId, req.params.taskId);
        if (!task) {
            res.status(404).json({ error: "Task not found" });
            return;
        }

        const fullOutput = taskManager.getOutput(projectId, req.params.taskId);
        const truncated = fullOutput.length > MAX_LOG_SIZE;
        const output = truncated ? fullOutput.slice(-MAX_LOG_SIZE) : fullOutput;

        res.json({
            taskId: task.taskId,
            output,
            truncated
        });
    });

    return app;
}
