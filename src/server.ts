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

function dashboardHtml(): string {
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
    .cr{color:#22c55e}.cq{color:#f59e0b}.ct{color:#60a5fa}
    table{width:100%;border-collapse:collapse;background:#1e2130;border-radius:12px;overflow:hidden}
    th{background:#161925;color:#64748b;font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;padding:10px 16px;text-align:left;font-weight:600}
    td{padding:12px 16px;border-top:1px solid #252a3a;font-size:.85rem;vertical-align:middle}
    tr:hover td{background:#252a3a}
    .badge{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:.7rem;font-weight:600;white-space:nowrap}
    .b-running{background:#14532d;color:#22c55e}
    .b-queued{background:#451a03;color:#f59e0b}
    .b-retrying{background:#1e3a5f;color:#60a5fa}
    .proj{background:#252a3a;padding:2px 8px;border-radius:4px;font-size:.73rem;color:#94a3b8}
    .mono{font-family:ui-monospace,'SF Mono',monospace;font-size:.76rem;color:#94a3b8}
    .ttitle{font-weight:500;color:#f1f5f9}
    .tprompt{color:#64748b;font-size:.76rem;margin-top:2px}
    .empty{text-align:center;color:#4a5568;padding:48px}
    a.out{font-size:.76rem;color:#64748b;text-decoration:none}
    a.out:hover{color:#94a3b8}
  </style>
</head>
<body>
  <header>
    <h1>Implementer Dashboard</h1>
    <div style="display:flex;align-items:center;gap:16px">
      <div class="live"><span class="dot" id="dot"></span><span id="upd">Connecting…</span></div>
      <a href="/dashboard/logout" class="out">Sign out</a>
    </div>
  </header>
  <div class="stats">
    <div class="stat"><div class="stat-label">Running</div><div class="stat-val cr" id="sr">—</div></div>
    <div class="stat"><div class="stat-label">Queued</div><div class="stat-val cq" id="sq">—</div></div>
    <div class="stat"><div class="stat-label">Retrying</div><div class="stat-val ct" id="st">—</div></div>
  </div>
  <table>
    <thead><tr>
      <th>Status</th><th>Project</th><th>Task ID</th><th>Title / Prompt</th><th>Duration</th><th>Started</th>
    </tr></thead>
    <tbody id="tb"><tr><td colspan="6" class="empty">Connecting…</td></tr></tbody>
  </table>
  <script>
    function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    function badge(s){const m={running:['b-running','Running'],queued:['b-queued','Queued'],retrying:['b-retrying','Retrying']};const[c,l]=m[s]||['','Unknown'];return '<span class="badge '+c+'">'+l+'</span>';}
    function dur(s){if(s<60)return s+'s';const m=Math.floor(s/60),r=s%60;if(m<60)return m+'m '+r+'s';return Math.floor(m/60)+'h '+(m%60)+'m';}
    const es=new EventSource('/dashboard/events');
    es.onmessage=function(e){
      const{tasks,stats}=JSON.parse(e.data);
      document.getElementById('sr').textContent=stats.running;
      document.getElementById('sq').textContent=stats.queued;
      document.getElementById('st').textContent=stats.retrying;
      const tb=document.getElementById('tb');
      if(!tasks.length){tb.innerHTML='<tr><td colspan="6" class="empty">No active tasks</td></tr>';return;}
      tb.innerHTML=tasks.map(t=>'<tr>'
        +'<td>'+badge(t.status)+'</td>'
        +'<td><span class="proj">'+esc(t.projectId)+'</span></td>'
        +'<td><span class="mono">'+esc(t.taskId)+'</span></td>'
        +'<td>'+(t.title?'<div class="ttitle">'+esc(t.title)+'</div>':'')+'<div class="tprompt">'+esc(t.prompt.length>90?t.prompt.slice(0,90)+'\u2026':t.prompt)+'</div></td>'
        +'<td class="mono">'+dur(t.durationSeconds)+'</td>'
        +'<td class="mono">'+new Date(t.startedAt).toLocaleTimeString()+'</td>'
        +'</tr>').join('');
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
            res.status(404).json({ error: "Not found" });
            return;
        }
        if (!isDashboardAuthenticated(req, config.server.adminPassword)) {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.send(loginHtml());
            return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(dashboardHtml());
    });

    // POST /dashboard — process login form
    app.post("/dashboard", (req, res) => {
        if (!config.server.adminPassword) {
            res.status(404).json({ error: "Not found" });
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

    // GET /dashboard/events — Server-Sent Events stream of active tasks
    app.get("/dashboard/events", (req, res) => {
        if (!config.server.adminPassword) {
            res.status(404).json({ error: "Not found" });
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
            const tasks = taskManager.listAllActiveTasks().map((task) => ({
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
                running: tasks.filter((t) => t.status === "running").length,
                queued: tasks.filter((t) => t.status === "queued").length,
                retrying: tasks.filter((t) => t.status === "retrying").length
            };
            res.write(`data: ${JSON.stringify({ tasks, stats })}\n\n`);
        };

        send();
        const interval = setInterval(send, 3000);
        req.on("close", () => clearInterval(interval));
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
