export const openApiSpec = {
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
                    continueTaskId: {
                        type: "string",
                        description:
                            "Task ID to continue from (inherits branch and chain).",
                        example: "TVchAThD"
                    },
                    callbackUrl: {
                        type: "string",
                        format: "uri",
                        description:
                            "URL to POST to when the task finishes. Body: { taskId, status }",
                        example: "https://example.com/webhook/task-done"
                    },
                    repoUrl: {
                        type: "string",
                        format: "uri",
                        description:
                            "Repository URL for dynamic tasks. Use with a template project (no preconfigured repos).",
                        example: "https://github.com/org/repo.git"
                    },
                    githubToken: {
                        type: "string",
                        description:
                            "GitHub token for the dynamic repository. Used for clone, push, and PR operations.",
                        example: "ghp_xxxxxxxxxxxx"
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
                        enum: ["starting"],
                        example: "starting"
                    },
                    parentTaskId: {
                        type: "string",
                        nullable: true,
                        description: "Direct parent task ID in the chain (null for standalone tasks)"
                    },
                    chainId: {
                        type: "string",
                        nullable: true,
                        description: "Root task ID of the chain (null for standalone tasks)"
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
                    title: {
                        type: "string",
                        nullable: true,
                        description: "Auto-generated short title for the task (null until generated)"
                    },
                    parentTaskId: {
                        type: "string",
                        nullable: true,
                        description: "Direct parent task ID in the chain (null for standalone tasks)"
                    },
                    chainId: {
                        type: "string",
                        nullable: true,
                        description: "Root task ID of the chain (null for standalone tasks)"
                    },
                    status: {
                        type: "string",
                        enum: ["queued", "starting", "running", "retrying", "completed", "failed", "interrupted", "cancelled"]
                    },
                    createdAt: {
                        type: "string",
                        format: "date-time",
                        description: "ISO timestamp of when the task was added to the queue"
                    },
                    startedAt: {
                        type: "string",
                        format: "date-time",
                        nullable: true,
                        description: "ISO timestamp of when the task began active execution (left the queue). Null for tasks that have not yet started."
                    },
                    completedAt: {
                        type: "string",
                        format: "date-time",
                        nullable: true
                    },
                    durationSeconds: {
                        type: "number",
                        description:
                            "Elapsed execution time in seconds, measured from startedAt (excludes queue wait time). Running tasks show time so far."
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
                            type: "array",
                            items: {
                                type: "string",
                                enum: ["queued", "starting", "running", "retrying", "completed", "failed", "interrupted", "cancelled"]
                            }
                        },
                        style: "form",
                        explode: true
                    },
                    {
                        name: "chainId",
                        in: "query",
                        required: false,
                        description:
                            "Filter tasks by chain ID (root task ID). Returns only tasks belonging to the specified chain.",
                        schema: { type: "string" }
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
        },
        "/webhook/github": {
            post: {
                summary: "Unified GitHub webhook (auto-routes by repo)",
                description:
                    "Receives GitHub webhook events for any project. The handler automatically determines " +
                    "which project the event belongs to based on the repository name in the payload. " +
                    "Authenticated via HMAC SHA-256 signature using the global server.webhookSecret. " +
                    "This allows all GitHub repositories to share a single webhook URL. " +
                    "Configure this URL as the webhook Payload URL in your GitHub repository settings.",
                security: [],
                parameters: [
                    {
                        name: "X-GitHub-Event",
                        in: "header",
                        required: true,
                        description: "GitHub event type (e.g. pull_request, check_run)",
                        schema: { type: "string" }
                    },
                    {
                        name: "X-Hub-Signature-256",
                        in: "header",
                        required: true,
                        description: "HMAC SHA-256 signature of the payload body (uses server.webhookSecret)",
                        schema: { type: "string" }
                    },
                    {
                        name: "X-GitHub-Delivery",
                        in: "header",
                        required: false,
                        description: "Unique delivery ID for this webhook event",
                        schema: { type: "string" }
                    }
                ],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                description: "GitHub webhook event payload"
                            }
                        }
                    }
                },
                responses: {
                    "200": {
                        description: "Webhook processed",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        accepted: {
                                            type: "boolean",
                                            description:
                                                "Whether the event triggered a poll"
                                        },
                                        projectId: {
                                            type: "string",
                                            nullable: true,
                                            description:
                                                "The auto-detected project ID (null if no project matched)"
                                        },
                                        reason: {
                                            type: "string",
                                            description:
                                                "Description of the event or reason for skipping"
                                        }
                                    }
                                }
                            }
                        }
                    },
                    "400": {
                        description:
                            "Invalid request (missing headers, body, or server.webhookSecret not configured)",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/Error" }
                            }
                        }
                    },
                    "401": {
                        description: "Invalid webhook signature",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/Error" }
                            }
                        }
                    }
                }
            }
        },
        "/webhook/github/{projectId}": {
            post: {
                summary: "Receive GitHub webhook events",
                description:
                    "Receives GitHub webhook events and triggers an immediate PR/pipeline poll for the project. " +
                    "Authenticated via HMAC SHA-256 signature verification (X-Hub-Signature-256 header). " +
                    "Responds to pull_request (state changes), check_run, check_suite, and workflow_run (completed) events. " +
                    "Configure this URL as the webhook Payload URL in your GitHub repository settings.",
                security: [],
                parameters: [
                    {
                        name: "projectId",
                        in: "path",
                        required: true,
                        description: "The project ID as defined in config.yaml",
                        schema: { type: "string" }
                    },
                    {
                        name: "X-GitHub-Event",
                        in: "header",
                        required: true,
                        description: "GitHub event type (e.g. pull_request, check_run)",
                        schema: { type: "string" }
                    },
                    {
                        name: "X-Hub-Signature-256",
                        in: "header",
                        required: true,
                        description: "HMAC SHA-256 signature of the payload body",
                        schema: { type: "string" }
                    },
                    {
                        name: "X-GitHub-Delivery",
                        in: "header",
                        required: false,
                        description: "Unique delivery ID for this webhook event",
                        schema: { type: "string" }
                    }
                ],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                description: "GitHub webhook event payload"
                            }
                        }
                    }
                },
                responses: {
                    "200": {
                        description: "Webhook processed",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        accepted: {
                                            type: "boolean",
                                            description:
                                                "Whether the event triggered a poll"
                                        },
                                        reason: {
                                            type: "string",
                                            description:
                                                "Description of the event or reason for skipping"
                                        }
                                    }
                                }
                            }
                        }
                    },
                    "400": {
                        description:
                            "Invalid request (missing headers, body, or webhooks not configured)",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/Error" }
                            }
                        }
                    },
                    "401": {
                        description: "Invalid webhook signature",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/Error" }
                            }
                        }
                    },
                    "404": {
                        description: "Project not found",
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
