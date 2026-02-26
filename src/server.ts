import express from "express";
import { createHash } from "node:crypto";
import swaggerUi from "swagger-ui-express";
import { z } from "zod";
import { TaskManager, TaskActiveError } from "./task-manager.js";
import { UsageLimitError } from "./usage-limiter.js";
import { extractLastAssistantMessage } from "./executor.js";
import type { Config, TaskStatus } from "./types.js";

const TaskCreateSchema = z.object({
    prompt: z.string().min(1),
    pullRequestNumber: z.number().int().positive().optional(),
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
                    pullRequestNumber: {
                        type: "integer",
                        description:
                            "Continue work on an existing pull request. Tasks with the same PR number run sequentially.",
                        example: 42
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
                    title: {
                        type: "string",
                        nullable: true,
                        description: "Auto-generated short title for the task (null until generated)"
                    },
                    pullRequestNumber: {
                        type: "integer",
                        nullable: true,
                        description: "Pull request number this task is linked to (null for standalone tasks)"
                    },
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
                            type: "array",
                            items: {
                                type: "string",
                                enum: ["queued", "running", "retrying", "completed", "failed", "interrupted"]
                            }
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

// ── Dashboard helpers ────────────────────────────────────────────────────────

function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx < 0) continue;
        const key = part.slice(0, idx).trim();
        if (key) out[key] = part.slice(idx + 1).trim();
    }
    return out;
}

function dashboardToken(password: string): string {
    return createHash("sha256").update(`impl:${password}`).digest("hex");
}

function isDashboardAuthenticated(req: express.Request, adminPassword: string): boolean {
    const cookies = parseCookies(req.headers.cookie);
    return cookies["impl_dash"] === dashboardToken(adminPassword);
}

function loginHtml(error = false): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Implementer — Dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#1e2130;border-radius:12px;padding:40px;width:360px}
    h2{font-size:1.2rem;font-weight:600;margin-bottom:24px}
    label{display:block;font-size:.78rem;color:#94a3b8;margin-bottom:6px}
    input{width:100%;background:#0f1117;border:1px solid #2a2f42;border-radius:6px;padding:10px 14px;color:#e2e8f0;font-size:.875rem;outline:none}
    input:focus{border-color:#3b82f6}
    button{width:100%;margin-top:12px;background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:10px;font-size:.875rem;font-weight:600;cursor:pointer}
    button:hover{background:#2563eb}
    .err{color:#f87171;font-size:.78rem;margin-top:10px}
  </style>
</head>
<body>
  <div class="card">
    <h2>Implementer Dashboard</h2>
    <form method="POST" action="/dashboard">
      <label for="pw">Admin password</label>
      <input type="password" id="pw" name="password" autofocus placeholder="Enter password">
      <button type="submit">Sign in</button>
      ${error ? '<p class="err">Incorrect password.</p>' : ""}
    </form>
  </div>
</body>
</html>`;
}

function dashboardHtml(hasPassword: boolean): string {
    const signOutLink = hasPassword ? '<a href="/dashboard/logout" class="out">Sign out</a>' : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Implementer Dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;padding:24px}
    header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
    h1{font-size:1.4rem;font-weight:600}
    .live{display:flex;align-items:center;gap:8px;font-size:.78rem;color:#94a3b8}
    .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pulse 2s infinite;flex-shrink:0}
    .dot.err{background:#ef4444;animation:none}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
    .stats{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
    .stat{background:#1e2130;border-radius:8px;padding:14px 20px;min-width:110px}
    .stat-label{font-size:.68rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}
    .stat-val{font-size:1.8rem;font-weight:700;margin-top:2px}
    .cr{color:#22c55e}.cq{color:#f59e0b}.ct{color:#60a5fa}.cc{color:#94a3b8}.cf{color:#ef4444}
    .section-title{font-size:.8rem;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}
    .projects{display:flex;gap:10px;margin-bottom:8px;flex-wrap:wrap}
    .proj-card{background:#1e2130;border-radius:8px;padding:14px 18px;min-width:160px;border:1px solid #252a3a;cursor:pointer;user-select:none;transition:border-color .15s,background .15s}
    .proj-card:hover{border-color:#3b4256}
    .proj-card.selected{border-color:#3b82f6;background:#1a2035}
    .proj-name{font-size:.82rem;font-weight:600;color:#e2e8f0;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .proj-stats{display:flex;gap:8px;font-size:.72rem;flex-wrap:wrap}
    .ps{padding:1px 7px;border-radius:4px;font-weight:600}
    .ps-running{background:#14532d;color:#22c55e}
    .ps-queued{background:#451a03;color:#f59e0b}
    .ps-retrying{background:#1e3a5f;color:#60a5fa}
    .ps-completed{background:#1a2535;color:#64748b}
    .ps-failed{background:#3b0f0f;color:#ef4444}
    .proj-hint{font-size:.72rem;color:#4a5568;margin-bottom:18px;min-height:16px}
    .filters{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
    .filter-btn{padding:4px 12px;border-radius:6px;border:1px solid #2a2f42;background:transparent;color:#94a3b8;font-size:.75rem;cursor:pointer}
    .filter-btn.active{background:#3b82f6;border-color:#3b82f6;color:#fff}
    table{width:100%;border-collapse:collapse;background:#1e2130;border-radius:12px;overflow:hidden}
    th{background:#161925;color:#64748b;font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;padding:10px 16px;text-align:left;font-weight:600}
    td{padding:12px 16px;border-top:1px solid #252a3a;font-size:.85rem;vertical-align:middle}
    tr.clickable{cursor:pointer}
    tr.clickable:hover td{background:#252a3a}
    .badge{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:.7rem;font-weight:600;white-space:nowrap}
    .b-running{background:#14532d;color:#22c55e}
    .b-queued{background:#451a03;color:#f59e0b}
    .b-retrying{background:#1e3a5f;color:#60a5fa}
    .b-completed{background:#1a2535;color:#64748b}
    .b-failed{background:#3b0f0f;color:#ef4444}
    .b-interrupted{background:#2a1f3a;color:#a78bfa}
    .proj-tag{background:#252a3a;padding:2px 8px;border-radius:4px;font-size:.73rem;color:#94a3b8}
    .mono{font-family:ui-monospace,'SF Mono',monospace;font-size:.76rem;color:#94a3b8}
    .ttitle{font-weight:500;color:#f1f5f9}
    .tprompt{color:#64748b;font-size:.76rem;margin-top:2px}
    .empty{text-align:center;color:#4a5568;padding:48px}
    a.out{font-size:.76rem;color:#64748b;text-decoration:none}
    a.out:hover{color:#94a3b8}
    .btn-new{padding:6px 14px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:.78rem;font-weight:600;cursor:pointer}
    .btn-new:hover{background:#2563eb}
    /* Modals */
    .overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px}
    .modal{background:#1e2130;border-radius:12px;width:100%;max-width:700px;max-height:90vh;display:flex;flex-direction:column;border:1px solid #2a2f42;box-shadow:0 20px 60px rgba(0,0,0,.5)}
    .modal-hd{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #252a3a;flex-shrink:0;gap:12px}
    .modal-ttl{font-size:1rem;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .modal-x{background:transparent;border:none;color:#64748b;font-size:1.1rem;cursor:pointer;padding:4px 8px;border-radius:4px;flex-shrink:0;line-height:1}
    .modal-x:hover{background:#252a3a;color:#e2e8f0}
    .modal-bd{padding:20px;overflow-y:auto;flex:1}
    .modal-ft{padding:14px 20px;border-top:1px solid #252a3a;display:flex;gap:8px;justify-content:flex-end;flex-shrink:0}
    .det-row{margin-bottom:14px}
    .det-lbl{font-size:.7rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;font-weight:600}
    .det-val{font-size:.875rem;color:#e2e8f0;word-break:break-word}
    .det-pre{white-space:pre-wrap;word-break:break-word;background:#0f1117;padding:12px;border-radius:6px;font-family:ui-monospace,'SF Mono',monospace;font-size:.78rem;color:#cbd5e1;max-height:220px;overflow-y:auto;line-height:1.5}
    .det-err{background:#3b0f0f;color:#ef4444;padding:10px 14px;border-radius:6px;font-size:.82rem;word-break:break-word}
    .pr-link{color:#60a5fa;text-decoration:none;font-size:.82rem}
    .pr-link:hover{text-decoration:underline}
    .btn{padding:8px 16px;border-radius:6px;border:none;font-size:.8rem;font-weight:600;cursor:pointer;transition:background .15s}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .btn-sec{background:#252a3a;color:#94a3b8}
    .btn-sec:hover:not(:disabled){background:#2a2f42}
    .btn-ret{background:#451a03;color:#f59e0b}
    .btn-ret:hover:not(:disabled){background:#78350f}
    .btn-pri{background:#3b82f6;color:#fff}
    .btn-pri:hover:not(:disabled){background:#2563eb}
    .form-g{margin-bottom:16px}
    .form-lbl{display:block;font-size:.78rem;color:#94a3b8;margin-bottom:6px}
    .form-inp{width:100%;background:#0f1117;border:1px solid #2a2f42;border-radius:6px;padding:10px 14px;color:#e2e8f0;font-size:.875rem;outline:none;font-family:inherit}
    .form-inp:focus{border-color:#3b82f6}
    textarea.form-inp{resize:vertical}
    select.form-inp option{background:#1e2130}
    .form-err{background:#3b0f0f;color:#ef4444;padding:10px 14px;border-radius:6px;font-size:.8rem;margin-top:8px}
  </style>
</head>
<body>
  <header>
    <h1>Implementer Dashboard</h1>
    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn-new" onclick="openNewTask()">+ New Task</button>
      <div class="live"><span class="dot" id="dot"></span><span id="upd">Connecting\u2026</span></div>
      ${signOutLink}
    </div>
  </header>
  <div class="stats">
    <div class="stat"><div class="stat-label">Running</div><div class="stat-val cr" id="sr">\u2014</div></div>
    <div class="stat"><div class="stat-label">Queued</div><div class="stat-val cq" id="sq">\u2014</div></div>
    <div class="stat"><div class="stat-label">Retrying</div><div class="stat-val ct" id="st">\u2014</div></div>
    <div class="stat"><div class="stat-label">Completed</div><div class="stat-val cc" id="sc">\u2014</div></div>
    <div class="stat"><div class="stat-label">Failed</div><div class="stat-val cf" id="sf">\u2014</div></div>
  </div>
  <div class="section-title">Projects</div>
  <div class="projects" id="projects"><div style="color:#4a5568;font-size:.82rem">Loading\u2026</div></div>
  <div class="proj-hint" id="proj-hint">Click a project card to filter tasks by project.</div>
  <div class="section-title">Tasks</div>
  <div class="filters" id="filters">
    <button class="filter-btn active" data-filter="all" onclick="setFilter('all')">All</button>
    <button class="filter-btn" data-filter="running" onclick="setFilter('running')">Running</button>
    <button class="filter-btn" data-filter="queued" onclick="setFilter('queued')">Queued</button>
    <button class="filter-btn" data-filter="retrying" onclick="setFilter('retrying')">Retrying</button>
    <button class="filter-btn" data-filter="completed" onclick="setFilter('completed')">Completed</button>
    <button class="filter-btn" data-filter="failed" onclick="setFilter('failed')">Failed</button>
    <button class="filter-btn" data-filter="interrupted" onclick="setFilter('interrupted')">Interrupted</button>
  </div>
  <table>
    <thead><tr>
      <th>Status</th><th>Project</th><th>Task ID</th><th>Title / Prompt</th><th>Duration</th><th>Started</th>
    </tr></thead>
    <tbody id="tb"><tr><td colspan="6" class="empty">Connecting\u2026</td></tr></tbody>
  </table>

  <!-- Task Detail Modal -->
  <div id="task-overlay" class="overlay" style="display:none" onclick="if(event.target===this)closeTask()">
    <div class="modal">
      <div class="modal-hd">
        <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">
          <span class="modal-ttl" id="task-ttl">Task Details</span>
          <span id="task-badge"></span>
        </div>
        <button class="modal-x" onclick="closeTask()">&#x2715;</button>
      </div>
      <div class="modal-bd" id="task-bd"><div style="color:#4a5568;text-align:center;padding:32px">Loading\u2026</div></div>
      <div class="modal-ft">
        <button class="btn btn-sec" onclick="closeTask()">Close</button>
        <button class="btn btn-ret" id="task-retry" onclick="retryTask()" style="display:none">Retry Task</button>
      </div>
    </div>
  </div>

  <!-- New Task Modal -->
  <div id="nt-overlay" class="overlay" style="display:none" onclick="if(event.target===this)closeNewTask()">
    <div class="modal">
      <div class="modal-hd">
        <span class="modal-ttl">New Task</span>
        <button class="modal-x" onclick="closeNewTask()">&#x2715;</button>
      </div>
      <div class="modal-bd">
        <div class="form-g">
          <label class="form-lbl" for="nt-proj">Project</label>
          <select id="nt-proj" class="form-inp"></select>
        </div>
        <div class="form-g">
          <label class="form-lbl" for="nt-prompt">Prompt</label>
          <textarea id="nt-prompt" class="form-inp" rows="8" placeholder="Describe what to implement\u2026"></textarea>
        </div>
        <div class="form-g">
          <label class="form-lbl" for="nt-pr">Pull Request # <span style="color:#4a5568;font-weight:400">(optional)</span></label>
          <input type="number" id="nt-pr" class="form-inp" placeholder="42" min="1">
        </div>
        <div id="nt-err" class="form-err" style="display:none"></div>
      </div>
      <div class="modal-ft">
        <button class="btn btn-sec" onclick="closeNewTask()">Cancel</button>
        <button class="btn btn-pri" id="nt-submit" onclick="submitNewTask()">Create Task</button>
      </div>
    </div>
  </div>

  <script>
    var currentFilter='all',selectedProjects=new Set(),lastData=null,currentTaskId=null;
    function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    function badge(s){var m={running:['b-running','Running'],queued:['b-queued','Queued'],retrying:['b-retrying','Retrying'],completed:['b-completed','Completed'],failed:['b-failed','Failed'],interrupted:['b-interrupted','Interrupted']};var r=m[s]||['','Unknown'];return '<span class="badge '+r[0]+'">'+r[1]+'</span>';}
    function dur(s){if(s<60)return s+'s';var m=Math.floor(s/60),r=s%60;if(m<60)return m+'m '+r+'s';return Math.floor(m/60)+'h '+(m%60)+'m';}
    function fmtDate(d){try{return new Date(d).toLocaleString();}catch(e){return String(d);}}
    function setFilter(f){
      currentFilter=f;
      document.querySelectorAll('.filter-btn').forEach(function(b){b.classList.toggle('active',b.dataset.filter===f);});
      if(lastData)renderTasks(lastData.tasks);
    }
    function toggleProject(id){
      if(selectedProjects.has(id)){selectedProjects.delete(id);}else{selectedProjects.add(id);}
      updateProjHint();
      if(lastData){renderProjects(lastData.projects);renderTasks(lastData.tasks);}
    }
    function updateProjHint(){
      var el=document.getElementById('proj-hint');
      if(selectedProjects.size===0){el.textContent='Click a project card to filter tasks by project.';}
      else{var names=Array.from(selectedProjects).join(', ');el.textContent='Filtering by: '+names+'. Click again to deselect.';}
    }
    function renderProjects(projects){
      var el=document.getElementById('projects');
      var ids=Object.keys(projects);
      if(!ids.length){el.innerHTML='<div style="color:#4a5568;font-size:.82rem">No projects</div>';return;}
      el.innerHTML=ids.map(function(id){
        var p=projects[id],sel=selectedProjects.has(id);
        var parts=[];
        if(p.running)parts.push('<span class="ps ps-running">'+p.running+' running</span>');
        if(p.queued)parts.push('<span class="ps ps-queued">'+p.queued+' queued</span>');
        if(p.retrying)parts.push('<span class="ps ps-retrying">'+p.retrying+' retrying</span>');
        if(p.completed)parts.push('<span class="ps ps-completed">'+p.completed+' done</span>');
        if(p.failed)parts.push('<span class="ps ps-failed">'+p.failed+' failed</span>');
        if(!parts.length)parts.push('<span style="color:#4a5568;font-size:.72rem">No tasks</span>');
        return '<div class="proj-card'+(sel?' selected':'')+'" data-proj="'+esc(id)+'">'
          +'<div class="proj-name" title="'+esc(id)+'">'+(sel?'\u2714 ':'')+esc(id)+'</div>'
          +'<div class="proj-stats">'+parts.join('')+'</div>'
          +'</div>';
      }).join('');
      el.querySelectorAll('.proj-card').forEach(function(card){
        card.addEventListener('click',function(){toggleProject(this.dataset.proj);});
      });
    }
    function renderTasks(tasks){
      var filtered=tasks.filter(function(t){
        var statusOk=currentFilter==='all'||t.status===currentFilter;
        var projOk=selectedProjects.size===0||selectedProjects.has(t.projectId);
        return statusOk&&projOk;
      });
      var tb=document.getElementById('tb');
      if(!filtered.length){
        var msg='No tasks';
        if(currentFilter!=='all')msg+=' with status \u201c'+currentFilter+'\u201d';
        if(selectedProjects.size>0)msg+=' in selected project'+(selectedProjects.size>1?'s':'');
        tb.innerHTML='<tr><td colspan="6" class="empty">'+msg+'</td></tr>';return;
      }
      tb.innerHTML=filtered.map(function(t){
        return '<tr class="clickable" data-id="'+esc(t.taskId)+'" data-proj="'+esc(t.projectId)+'">'
          +'<td>'+badge(t.status)+'</td>'
          +'<td><span class="proj-tag">'+esc(t.projectId)+'</span></td>'
          +'<td><span class="mono">'+esc(t.taskId)+'</span></td>'
          +'<td>'+(t.title?'<div class="ttitle">'+esc(t.title)+'</div>':'')+'<div class="tprompt">'+esc(t.prompt.length>90?t.prompt.slice(0,90)+'\u2026':t.prompt)+'</div></td>'
          +'<td class="mono">'+dur(t.durationSeconds)+'</td>'
          +'<td class="mono">'+fmtDate(t.startedAt)+'</td>'
          +'</tr>';
      }).join('');
      tb.querySelectorAll('tr.clickable').forEach(function(row){
        row.addEventListener('click',function(){openTask(this.dataset.id,this.dataset.proj);});
      });
    }
    function openTask(taskId,projectId){
      currentTaskId=taskId;
      document.getElementById('task-ttl').textContent='Task '+taskId;
      document.getElementById('task-badge').innerHTML='';
      document.getElementById('task-bd').innerHTML='<div style="color:#4a5568;text-align:center;padding:32px">Loading\u2026</div>';
      document.getElementById('task-retry').style.display='none';
      document.getElementById('task-overlay').style.display='flex';
      fetch('/dashboard/api/task/'+encodeURIComponent(taskId))
        .then(function(r){return r.json();})
        .then(function(t){
          document.getElementById('task-badge').innerHTML=badge(t.status);
          var active=['queued','running','retrying'];
          document.getElementById('task-retry').style.display=active.includes(t.status)?'none':'';
          var prsHtml='None';
          if(t.pullRequests&&t.pullRequests.length){
            prsHtml=t.pullRequests.map(function(pr){
              var num=pr.url.split('/').pop();
              return '<a href="'+esc(pr.url)+'" target="_blank" rel="noopener" class="pr-link">'+esc(pr.repo)+' #'+esc(num)+'</a>';
            }).join(' &nbsp;&bull;&nbsp; ');
          }
          var html='';
          html+='<div class="det-row"><div class="det-lbl">Prompt</div><div class="det-pre">'+esc(t.prompt)+'</div></div>';
          if(t.title)html+='<div class="det-row"><div class="det-lbl">Title</div><div class="det-val">'+esc(t.title)+'</div></div>';
          html+='<div class="det-row"><div class="det-lbl">Project</div><div class="det-val">'+esc(t.projectId)+'</div></div>';
          if(t.branch)html+='<div class="det-row"><div class="det-lbl">Branch</div><div class="det-val mono">'+esc(t.branch)+'</div></div>';
          if(t.pullRequestNumber)html+='<div class="det-row"><div class="det-lbl">PR #</div><div class="det-val">'+esc(String(t.pullRequestNumber))+'</div></div>';
          html+='<div class="det-row"><div class="det-lbl">Duration</div><div class="det-val mono">'+dur(t.durationSeconds)+'</div></div>';
          html+='<div class="det-row"><div class="det-lbl">Started</div><div class="det-val mono">'+fmtDate(t.startedAt)+'</div></div>';
          if(t.completedAt)html+='<div class="det-row"><div class="det-lbl">Completed</div><div class="det-val mono">'+fmtDate(t.completedAt)+'</div></div>';
          html+='<div class="det-row"><div class="det-lbl">Pull Requests</div><div class="det-val">'+prsHtml+'</div></div>';
          if(t.error)html+='<div class="det-row"><div class="det-lbl">Error</div><div class="det-err">'+esc(t.error)+'</div></div>';
          if(t.output)html+='<div class="det-row"><div class="det-lbl">Output</div><div class="det-pre">'+esc(t.output)+'</div></div>';
          document.getElementById('task-bd').innerHTML=html;
        })
        .catch(function(){document.getElementById('task-bd').innerHTML='<div class="det-err">Failed to load task details.</div>';});
    }
    function closeTask(){
      document.getElementById('task-overlay').style.display='none';
      currentTaskId=null;
    }
    function retryTask(){
      if(!currentTaskId)return;
      if(!confirm('Retry task '+currentTaskId+'?'))return;
      var btn=document.getElementById('task-retry');
      btn.disabled=true;
      fetch('/dashboard/api/task/'+encodeURIComponent(currentTaskId)+'/retry',{method:'POST',headers:{'Content-Type':'application/json'}})
        .then(function(r){return r.json();})
        .then(function(d){
          btn.disabled=false;
          if(d.error){alert('Error: '+d.error);return;}
          closeTask();
        })
        .catch(function(){btn.disabled=false;alert('Failed to retry task');});
    }
    function openNewTask(){
      var projects=lastData?Object.keys(lastData.projects):[];
      var sel=document.getElementById('nt-proj');
      sel.innerHTML=projects.map(function(p){return '<option value="'+esc(p)+'">'+esc(p)+'</option>';}).join('');
      if(selectedProjects.size===1){sel.value=Array.from(selectedProjects)[0];}
      document.getElementById('nt-prompt').value='';
      document.getElementById('nt-pr').value='';
      document.getElementById('nt-err').style.display='none';
      document.getElementById('nt-submit').disabled=false;
      document.getElementById('nt-overlay').style.display='flex';
      setTimeout(function(){document.getElementById('nt-prompt').focus();},50);
    }
    function closeNewTask(){document.getElementById('nt-overlay').style.display='none';}
    function submitNewTask(){
      var projectId=document.getElementById('nt-proj').value;
      var prompt=document.getElementById('nt-prompt').value.trim();
      var pr=document.getElementById('nt-pr').value;
      var errEl=document.getElementById('nt-err');
      errEl.style.display='none';
      if(!projectId||!prompt){errEl.textContent='Project and prompt are required.';errEl.style.display='block';return;}
      var body={projectId:projectId,prompt:prompt};
      if(pr){var n=parseInt(pr,10);if(n>0)body.pullRequestNumber=n;}
      var btn=document.getElementById('nt-submit');
      btn.disabled=true;
      fetch('/dashboard/api/task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){return r.json();})
        .then(function(d){
          btn.disabled=false;
          if(d.error){errEl.textContent='Error: '+d.error;errEl.style.display='block';return;}
          closeNewTask();
        })
        .catch(function(){btn.disabled=false;errEl.textContent='Failed to create task.';errEl.style.display='block';});
    }
    document.addEventListener('keydown',function(e){
      if(e.key==='Escape'){
        if(document.getElementById('task-overlay').style.display!=='none')closeTask();
        else if(document.getElementById('nt-overlay').style.display!=='none')closeNewTask();
      }
    });
    var es=new EventSource('/dashboard/events');
    es.onmessage=function(e){
      var d=JSON.parse(e.data);
      lastData=d;
      document.getElementById('sr').textContent=d.stats.running;
      document.getElementById('sq').textContent=d.stats.queued;
      document.getElementById('st').textContent=d.stats.retrying;
      document.getElementById('sc').textContent=d.stats.completed;
      document.getElementById('sf').textContent=d.stats.failed;
      renderProjects(d.projects);
      renderTasks(d.tasks);
      document.getElementById('dot').className='dot';
      document.getElementById('upd').textContent='Updated '+new Date().toLocaleTimeString();
    };
    es.onerror=function(){
      document.getElementById('dot').className='dot err';
      document.getElementById('upd').textContent='Connection lost';
    };
  </script>
</body>
</html>`;
}

export function createServer(
    taskManager: TaskManager,
    config: Config
): express.Express {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    // Swagger UI — served before auth so it's accessible without a key
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));

    // ── Dashboard ────────────────────────────────────────────────────────────
    // Served before the project auth middleware; has its own adminPassword auth.

    const DASH_COOKIE = "impl_dash";

    // GET /dashboard — login form or live dashboard
    app.get("/dashboard", (req, res) => {
        if (!config.server.adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, config.server.adminPassword)) {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.send(loginHtml());
            return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(dashboardHtml(true));
    });

    // POST /dashboard — process login form
    app.post("/dashboard", (req, res) => {
        if (!config.server.adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        const password = typeof req.body?.password === "string" ? req.body.password : "";
        if (password === config.server.adminPassword) {
            const token = dashboardToken(config.server.adminPassword);
            res.setHeader("Set-Cookie", `${DASH_COOKIE}=${token}; Path=/dashboard; HttpOnly; SameSite=Strict`);
            res.redirect("/dashboard");
        } else {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.send(loginHtml(true));
        }
    });

    // GET /dashboard/logout — clear cookie and redirect
    app.get("/dashboard/logout", (_req, res) => {
        res.setHeader("Set-Cookie", `${DASH_COOKIE}=; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=0`);
        res.redirect("/dashboard");
    });

    // GET /dashboard/events — Server-Sent Events stream of all tasks + per-project stats
    app.get("/dashboard/events", (req, res) => {
        if (!config.server.adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, config.server.adminPassword)) {
            res.status(401).send("Unauthorized");
            return;
        }

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        const send = () => {
            const allTasks = taskManager.listAllTasks();
            const tasks = allTasks.slice(0, 200).map((task) => ({
                taskId: task.taskId,
                projectId: task.projectId,
                title: task.title ?? null,
                prompt: task.prompt,
                status: task.status,
                startedAt: task.startedAt,
                durationSeconds: Math.round(
                    (Date.now() - new Date(task.startedAt).getTime()) / 1000
                )
            }));

            const stats = {
                running: allTasks.filter((t) => t.status === "running").length,
                queued: allTasks.filter((t) => t.status === "queued").length,
                retrying: allTasks.filter((t) => t.status === "retrying").length,
                completed: allTasks.filter((t) => t.status === "completed").length,
                failed: allTasks.filter((t) => t.status === "failed").length,
                interrupted: allTasks.filter((t) => t.status === "interrupted").length,
                total: allTasks.length
            };

            const projects: Record<string, Record<string, number>> = {};
            for (const projectId of Object.keys(config.projects)) {
                projects[projectId] = { running: 0, queued: 0, retrying: 0, completed: 0, failed: 0, interrupted: 0 };
            }
            for (const task of allTasks) {
                if (!projects[task.projectId]) {
                    projects[task.projectId] = { running: 0, queued: 0, retrying: 0, completed: 0, failed: 0, interrupted: 0 };
                }
                const s = task.status as string;
                if (s in projects[task.projectId]) {
                    projects[task.projectId][s]++;
                }
            }

            res.write(`data: ${JSON.stringify({ tasks, stats, projects })}\n\n`);
        };

        send();
        const interval = setInterval(send, 3000);
        req.on("close", () => clearInterval(interval));
    });

    // GET /dashboard/api/task/:taskId — get full task details (dashboard auth)
    app.get("/dashboard/api/task/:taskId", (req, res) => {
        if (!config.server.adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, config.server.adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const allTasks = taskManager.listAllTasks();
        const task = allTasks.find((t) => t.taskId === req.params.taskId);
        if (!task) {
            res.status(404).json({ error: "Task not found" });
            return;
        }
        res.json({
            taskId: task.taskId,
            projectId: task.projectId,
            branch: task.branch,
            prompt: task.prompt,
            title: task.title ?? null,
            pullRequestNumber: task.pullRequestNumber ?? null,
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

    // POST /dashboard/api/task — create a new task (dashboard auth)
    app.post("/dashboard/api/task", async (req, res) => {
        if (!config.server.adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, config.server.adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const { projectId, prompt, pullRequestNumber } = req.body ?? {};
        if (typeof projectId !== "string" || !config.projects[projectId]) {
            res.status(400).json({ error: "Invalid or missing project ID" });
            return;
        }
        if (typeof prompt !== "string" || !prompt.trim()) {
            res.status(400).json({ error: "Prompt is required" });
            return;
        }
        const prNum =
            typeof pullRequestNumber === "number" && pullRequestNumber > 0
                ? pullRequestNumber
                : typeof pullRequestNumber === "string" && parseInt(pullRequestNumber, 10) > 0
                  ? parseInt(pullRequestNumber, 10)
                  : undefined;
        try {
            const task = await taskManager.startTask(projectId, {
                prompt: prompt.trim(),
                pullRequestNumber: prNum
            });
            res.json({ taskId: task.taskId, branch: task.branch, status: task.status });
        } catch (err) {
            if (err instanceof UsageLimitError) {
                res.status(429).json({ error: err.message });
                return;
            }
            res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
        }
    });

    // POST /dashboard/api/task/:taskId/retry — retry a task (dashboard auth)
    app.post("/dashboard/api/task/:taskId/retry", async (req, res) => {
        if (!config.server.adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, config.server.adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const allTasks = taskManager.listAllTasks();
        const task = allTasks.find((t) => t.taskId === req.params.taskId);
        if (!task) {
            res.status(404).json({ error: "Task not found" });
            return;
        }
        try {
            const retried = await taskManager.retryTask(task.projectId, task.taskId);
            res.json({ taskId: retried.taskId, branch: retried.branch, status: retried.status });
        } catch (err) {
            if (err instanceof TaskActiveError) {
                res.status(409).json({ error: err.message });
                return;
            }
            res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
        }
    });

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
        // Swagger UI and dashboard have their own auth
        if (req.path.startsWith("/docs") || req.path.startsWith("/dashboard")) return next();

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
                title: task.title ?? null,
                pullRequestNumber: task.pullRequestNumber ?? null,
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
            title: task.title ?? null,
            pullRequestNumber: task.pullRequestNumber ?? null,
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
