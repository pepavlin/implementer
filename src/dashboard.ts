import { createHash } from "node:crypto";
import type express from "express";
import {
    TaskManager,
    TaskActiveError,
    TaskCancelError,
    TaskEditError
} from "./task-manager/task-manager.js";
import { UsageLimitError } from "./usage-limiter.js";
import { extractLastAssistantMessage } from "./executor.js";
import type { Config } from "./types.js";

// ── Auth helpers ─────────────────────────────────────────────────────────────

export function parseCookies(
    header: string | undefined
): Record<string, string> {
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

export function dashboardToken(password: string): string {
    return createHash("sha256").update(`impl:${password}`).digest("hex");
}

export function isDashboardAuthenticated(
    req: express.Request,
    adminPassword: string
): boolean {
    const cookies = parseCookies(req.headers.cookie);
    return cookies["impl_dash"] === dashboardToken(adminPassword);
}

// ── Data helpers ─────────────────────────────────────────────────────────────

export function buildDashboardData(
    taskManager: TaskManager,
    config: Config
): {
    tasks: object[];
    stats: Record<string, number>;
    projects: Record<string, Record<string, number>>;
} {
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
        projects[projectId] = {
            running: 0,
            queued: 0,
            retrying: 0,
            completed: 0,
            failed: 0,
            interrupted: 0
        };
    }
    for (const task of allTasks) {
        if (!projects[task.projectId]) {
            projects[task.projectId] = {
                running: 0,
                queued: 0,
                retrying: 0,
                completed: 0,
                failed: 0,
                interrupted: 0
            };
        }
        const s = task.status as string;
        if (s in projects[task.projectId]) {
            projects[task.projectId][s]++;
        }
    }

    return { tasks, stats, projects };
}

// ── HTML templates ────────────────────────────────────────────────────────────

const THEME_FOUC_SCRIPT = `<script>try{if(localStorage.getItem('impl-theme')==='light')document.documentElement.setAttribute('data-theme','light')}catch(e){}</script>`;

const THEME_TOGGLE_JS = `
    function toggleTheme(){
      var html=document.documentElement,isLight=html.getAttribute('data-theme')==='light';
      if(isLight){html.removeAttribute('data-theme');try{localStorage.removeItem('impl-theme')}catch(e){}}
      else{html.setAttribute('data-theme','light');try{localStorage.setItem('impl-theme','light')}catch(e){}}
      updateThemeBtn();
    }
    function updateThemeBtn(){
      var btn=document.getElementById('theme-toggle'),isLight=document.documentElement.getAttribute('data-theme')==='light';
      if(btn)btn.textContent=isLight?'\u263E':'\u2600';
    }
    updateThemeBtn();`;

export function loginHtml(error = false): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Implementer — Dashboard</title>
  ${THEME_FOUC_SCRIPT}
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0f1117;--bg-card:#1e2130;--border:#2a2f42;--text:#e2e8f0;--text2:#94a3b8;--bg-inp:#0f1117}
    [data-theme=light]{--bg:#f8fafc;--bg-card:#ffffff;--border:#cbd5e1;--text:#0f172a;--text2:#475569;--bg-inp:#ffffff}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:var(--bg-card);border-radius:12px;padding:40px;width:360px}
    h2{font-size:1.2rem;font-weight:600;margin-bottom:24px}
    label{display:block;font-size:.78rem;color:var(--text2);margin-bottom:6px}
    input{width:100%;background:var(--bg-inp);border:1px solid var(--border);border-radius:6px;padding:10px 14px;color:var(--text);font-size:.875rem;outline:none}
    input:focus{border-color:#3b82f6}
    button[type=submit]{width:100%;margin-top:12px;background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:10px;font-size:.875rem;font-weight:600;cursor:pointer}
    button[type=submit]:hover{background:#2563eb}
    .err{color:#f87171;font-size:.78rem;margin-top:10px}
    .theme-btn{position:fixed;top:16px;right:16px;background:var(--bg-card);border:1px solid var(--border);color:var(--text2);border-radius:6px;padding:5px 10px;font-size:.85rem;cursor:pointer;transition:color .15s,background .15s;line-height:1}
    .theme-btn:hover{color:var(--text)}
  </style>
</head>
<body>
  <button class="theme-btn" id="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode">&#x2600;</button>
  <div class="card">
    <h2>Implementer Dashboard</h2>
    <form method="POST" action="/dashboard">
      <label for="pw">Admin password</label>
      <input type="password" id="pw" name="password" autofocus placeholder="Enter password">
      <button type="submit">Sign in</button>
      ${error ? '<p class="err">Incorrect password.</p>' : ""}
    </form>
  </div>
  <script>${THEME_TOGGLE_JS}
  </script>
</body>
</html>`;
}

export function dashboardHtml(hasPassword: boolean): string {
    const signOutLink = hasPassword
        ? '<a href="/dashboard/logout" class="out">Sign out</a>'
        : "";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Implementer Dashboard</title>
  ${THEME_FOUC_SCRIPT}
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0f1117;--bg-card:#1e2130;--bg-head:#161925;--bg-code:#0f1117;--bg-inp:#0f1117;
      --border:#252a3a;--border2:#2a2f42;--hover-bg:#252a3a;--hover-border:#3b4256;--proj-sel:#1a2035;
      --text:#e2e8f0;--text2:#94a3b8;--text3:#64748b;--text4:#4a5568;--text5:#f1f5f9;--text-code:#cbd5e1;
      --overlay:rgba(0,0,0,.75);--shadow:0 20px 60px rgba(0,0,0,.5);--tag-bg:#252a3a;
      --b-run-bg:#14532d;--b-run-fg:#22c55e;--b-q-bg:#451a03;--b-q-fg:#f59e0b;
      --b-ret-bg:#1e3a5f;--b-ret-fg:#60a5fa;--b-done-bg:#1a2535;--b-done-fg:#64748b;
      --b-fail-bg:#3b0f0f;--b-fail-fg:#ef4444;--b-int-bg:#2a1f3a;--b-int-fg:#a78bfa;
      --b-can-bg:#1a2535;--b-can-fg:#64748b;
      --btn-sec-bg:#252a3a;--btn-sec-fg:#94a3b8;--btn-sec-h:#2a2f42;--btn-ret-h:#78350f;
      --btn-cancel-bg:#3b0f0f;--btn-cancel-fg:#ef4444;--btn-cancel-h:#7f1d1d;
      --btn-edit-bg:#1e3a5f;--btn-edit-fg:#60a5fa;--btn-edit-h:#1e40af;
      --link:#60a5fa}
    [data-theme=light]{
      --bg:#f8fafc;--bg-card:#ffffff;--bg-head:#f1f5f9;--bg-code:#f1f5f9;--bg-inp:#ffffff;
      --border:#e2e8f0;--border2:#cbd5e1;--hover-bg:#f1f5f9;--hover-border:#94a3b8;--proj-sel:#eff6ff;
      --text:#0f172a;--text2:#475569;--text3:#64748b;--text4:#94a3b8;--text5:#1e293b;--text-code:#374151;
      --overlay:rgba(0,0,0,.5);--shadow:0 20px 60px rgba(0,0,0,.15);--tag-bg:#f1f5f9;
      --b-run-bg:#dcfce7;--b-run-fg:#16a34a;--b-q-bg:#fef3c7;--b-q-fg:#d97706;
      --b-ret-bg:#dbeafe;--b-ret-fg:#2563eb;--b-done-bg:#f8fafc;--b-done-fg:#64748b;
      --b-fail-bg:#fee2e2;--b-fail-fg:#dc2626;--b-int-bg:#ede9fe;--b-int-fg:#7c3aed;
      --b-can-bg:#f8fafc;--b-can-fg:#64748b;
      --btn-sec-bg:#f1f5f9;--btn-sec-fg:#475569;--btn-sec-h:#e2e8f0;--btn-ret-h:#fbbf24;
      --btn-cancel-bg:#fee2e2;--btn-cancel-fg:#dc2626;--btn-cancel-h:#fca5a5;
      --btn-edit-bg:#dbeafe;--btn-edit-fg:#2563eb;--btn-edit-h:#93c5fd;
      --link:#2563eb}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);padding:24px}
    header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
    h1{font-size:1.4rem;font-weight:600}
    .live{display:flex;align-items:center;gap:8px;font-size:.78rem;color:var(--text2)}
    .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pulse 2s infinite;flex-shrink:0}
    .dot.err{background:#ef4444;animation:none}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
    .stats{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
    .stat{background:var(--bg-card);border-radius:8px;padding:14px 20px;min-width:110px}
    .stat-label{font-size:.68rem;color:var(--text2);text-transform:uppercase;letter-spacing:.05em}
    .stat-val{font-size:1.8rem;font-weight:700;margin-top:2px}
    .cr{color:#22c55e}.cq{color:#f59e0b}.ct{color:#60a5fa}.cc{color:var(--text2)}.cf{color:#ef4444}
    .section-title{font-size:.8rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}
    .projects{display:flex;gap:10px;margin-bottom:8px;flex-wrap:wrap}
    .proj-card{background:var(--bg-card);border-radius:8px;padding:14px 18px;min-width:160px;border:1px solid var(--border);cursor:pointer;user-select:none;transition:border-color .15s,background .15s}
    .proj-card:hover{border-color:var(--hover-border)}
    .proj-card.selected{border-color:#3b82f6;background:var(--proj-sel)}
    .proj-name{font-size:.82rem;font-weight:600;color:var(--text);margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .proj-stats{display:flex;gap:8px;font-size:.72rem;flex-wrap:wrap}
    .ps{padding:1px 7px;border-radius:4px;font-weight:600}
    .ps-running{background:var(--b-run-bg);color:var(--b-run-fg)}
    .ps-queued{background:var(--b-q-bg);color:var(--b-q-fg)}
    .ps-retrying{background:var(--b-ret-bg);color:var(--b-ret-fg)}
    .ps-completed{background:var(--b-done-bg);color:var(--b-done-fg)}
    .ps-failed{background:var(--b-fail-bg);color:var(--b-fail-fg)}
    .proj-hint{font-size:.72rem;color:var(--text4);margin-bottom:18px;min-height:16px}
    .muted{color:var(--text4)}
    .filters{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
    .filter-btn{padding:4px 12px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--text2);font-size:.75rem;cursor:pointer}
    .filter-btn.active{background:#3b82f6;border-color:#3b82f6;color:#fff}
    table{width:100%;border-collapse:collapse;background:var(--bg-card);border-radius:12px;overflow:hidden}
    th{background:var(--bg-head);color:var(--text3);font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;padding:10px 16px;text-align:left;font-weight:600}
    td{padding:12px 16px;border-top:1px solid var(--border);font-size:.85rem;vertical-align:middle}
    tr.clickable{cursor:pointer}
    tr.clickable:hover td{background:var(--hover-bg)}
    .badge{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:.7rem;font-weight:600;white-space:nowrap}
    .b-running{background:var(--b-run-bg);color:var(--b-run-fg)}
    .b-queued{background:var(--b-q-bg);color:var(--b-q-fg)}
    .b-retrying{background:var(--b-ret-bg);color:var(--b-ret-fg)}
    .b-completed{background:var(--b-done-bg);color:var(--b-done-fg)}
    .b-failed{background:var(--b-fail-bg);color:var(--b-fail-fg)}
    .b-interrupted{background:var(--b-int-bg);color:var(--b-int-fg)}
    .b-cancelled{background:var(--b-can-bg);color:var(--b-can-fg)}
    .proj-tag{background:var(--tag-bg);padding:2px 8px;border-radius:4px;font-size:.73rem;color:var(--text2)}
    .mono{font-family:ui-monospace,'SF Mono',monospace;font-size:.76rem;color:var(--text2)}
    .ttitle{font-weight:500;color:var(--text5)}
    .tprompt{color:var(--text3);font-size:.76rem;margin-top:2px}
    .empty{text-align:center;color:var(--text4);padding:48px}
    a.out{font-size:.76rem;color:var(--text3);text-decoration:none}
    a.out:hover{color:var(--text2)}
    .btn-new{padding:6px 14px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:.78rem;font-weight:600;cursor:pointer}
    .btn-new:hover{background:#2563eb}
    .btn-ref{padding:6px 14px;background:transparent;color:var(--text2);border:1px solid var(--border2);border-radius:6px;font-size:.78rem;font-weight:600;cursor:pointer;transition:background .15s,color .15s}
    .btn-ref:hover:not(:disabled){background:var(--bg-card);color:var(--text)}
    .btn-ref:disabled{opacity:.5;cursor:not-allowed}
    .btn-rfa{padding:6px 14px;background:transparent;color:#ef4444;border:1px solid #ef4444;border-radius:6px;font-size:.78rem;font-weight:600;cursor:pointer;transition:background .15s,color .15s}
    .btn-rfa:hover:not(:disabled){background:#3b0f0f}
    .btn-rfa:disabled{opacity:.5;cursor:not-allowed}
    .theme-btn{background:var(--bg-card);border:1px solid var(--border2);color:var(--text2);border-radius:6px;padding:5px 10px;font-size:.85rem;cursor:pointer;transition:color .15s,background .15s;line-height:1}
    .theme-btn:hover{color:var(--text)}
    /* Modals */
    .overlay{position:fixed;inset:0;background:var(--overlay);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px}
    .modal{background:var(--bg-card);border-radius:12px;width:100%;max-width:700px;max-height:90vh;display:flex;flex-direction:column;border:1px solid var(--border2);box-shadow:var(--shadow)}
    .modal-hd{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0;gap:12px}
    .modal-ttl{font-size:1rem;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .modal-x{background:transparent;border:none;color:var(--text3);font-size:1.1rem;cursor:pointer;padding:4px 8px;border-radius:4px;flex-shrink:0;line-height:1}
    .modal-x:hover{background:var(--hover-bg);color:var(--text)}
    .modal-bd{padding:20px;overflow-y:auto;flex:1}
    .modal-ft{padding:14px 20px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;flex-shrink:0}
    .det-row{margin-bottom:14px}
    .det-lbl{font-size:.7rem;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;font-weight:600}
    .det-val{font-size:.875rem;color:var(--text);word-break:break-word}
    .det-pre{white-space:pre-wrap;word-break:break-word;background:var(--bg-code);padding:12px;border-radius:6px;font-family:ui-monospace,'SF Mono',monospace;font-size:.78rem;color:var(--text-code);max-height:220px;overflow-y:auto;line-height:1.5}
    .det-err{background:var(--b-fail-bg);color:var(--b-fail-fg);padding:10px 14px;border-radius:6px;font-size:.82rem;word-break:break-word}
    .pr-link{color:var(--link);text-decoration:none;font-size:.82rem}
    .pr-link:hover{text-decoration:underline}
    .btn{padding:8px 16px;border-radius:6px;border:none;font-size:.8rem;font-weight:600;cursor:pointer;transition:background .15s}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .btn-sec{background:var(--btn-sec-bg);color:var(--btn-sec-fg)}
    .btn-sec:hover:not(:disabled){background:var(--btn-sec-h)}
    .btn-ret{background:var(--b-q-bg);color:var(--b-q-fg)}
    .btn-ret:hover:not(:disabled){background:var(--btn-ret-h)}
    .btn-cancel{background:var(--btn-cancel-bg);color:var(--btn-cancel-fg)}
    .btn-cancel:hover:not(:disabled){background:var(--btn-cancel-h)}
    .btn-edit{background:var(--btn-edit-bg);color:var(--btn-edit-fg)}
    .btn-edit:hover:not(:disabled){background:var(--btn-edit-h)}
    .btn-pri{background:#3b82f6;color:#fff}
    .btn-pri:hover:not(:disabled){background:#2563eb}
    .form-g{margin-bottom:16px}
    .form-lbl{display:block;font-size:.78rem;color:var(--text2);margin-bottom:6px}
    .form-inp{width:100%;background:var(--bg-inp);border:1px solid var(--border2);border-radius:6px;padding:10px 14px;color:var(--text);font-size:.875rem;outline:none;font-family:inherit}
    .form-inp:focus{border-color:#3b82f6}
    textarea.form-inp{resize:vertical}
    select.form-inp option{background:var(--bg-card)}
    .form-err{background:var(--b-fail-bg);color:var(--b-fail-fg);padding:10px 14px;border-radius:6px;font-size:.8rem;margin-top:8px}
  </style>
</head>
<body>
  <header>
    <h1>Implementer Dashboard</h1>
    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn-new" onclick="openNewTask()">+ New Task</button>
      <button class="btn-rfa" id="retry-failed-btn" onclick="retryAllFailed()">Retry All Failed</button>
      <button class="btn-ref" id="refresh-btn" onclick="refreshData()">\u21bb Refresh</button>
      <button class="theme-btn" id="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode">&#x2600;</button>
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
  <div class="projects" id="projects"><div class="muted" style="font-size:.82rem">Loading\u2026</div></div>
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
    <button class="filter-btn" data-filter="cancelled" onclick="setFilter('cancelled')">Cancelled</button>
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
      <div class="modal-bd" id="task-bd"><div class="muted" style="text-align:center;padding:32px">Loading\u2026</div></div>
      <div class="modal-ft">
        <button class="btn btn-sec" onclick="closeTask()">Close</button>
        <button class="btn btn-edit" id="task-edit" onclick="openEditTask()" style="display:none">Edit Task</button>
        <button class="btn btn-cancel" id="task-cancel" onclick="cancelTask()" style="display:none">Cancel Task</button>
        <button class="btn btn-ret" id="task-retry" onclick="retryTask()" style="display:none">Retry Task</button>
      </div>
    </div>
  </div>

  <!-- Edit Task Modal -->
  <div id="et-overlay" class="overlay" style="display:none" onclick="if(event.target===this)closeEditTask()">
    <div class="modal">
      <div class="modal-hd">
        <span class="modal-ttl">Edit Task</span>
        <button class="modal-x" onclick="closeEditTask()">&#x2715;</button>
      </div>
      <div class="modal-bd">
        <div class="form-g">
          <label class="form-lbl" for="et-prompt">Prompt</label>
          <textarea id="et-prompt" class="form-inp" rows="10" placeholder="Describe what to implement\u2026"></textarea>
        </div>
        <div id="et-err" class="form-err" style="display:none"></div>
      </div>
      <div class="modal-ft">
        <button class="btn btn-sec" onclick="closeEditTask()">Cancel</button>
        <button class="btn btn-pri" id="et-submit" onclick="submitEditTask()">Save Changes</button>
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
          <label class="form-lbl" for="nt-pr">Pull Request # <span class="muted" style="font-weight:400">(optional)</span></label>
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
    var currentFilter='all',selectedProjects=new Set(),lastData=null,currentTaskId=null,currentTaskData=null;
    function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    function badge(s){var m={running:['b-running','Running'],queued:['b-queued','Queued'],retrying:['b-retrying','Retrying'],completed:['b-completed','Completed'],failed:['b-failed','Failed'],interrupted:['b-interrupted','Interrupted'],cancelled:['b-cancelled','Cancelled']};var r=m[s]||['','Unknown'];return '<span class="badge '+r[0]+'">'+r[1]+'</span>';}
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
      if(!ids.length){el.innerHTML='<div class="muted" style="font-size:.82rem">No projects</div>';return;}
      el.innerHTML=ids.map(function(id){
        var p=projects[id],sel=selectedProjects.has(id);
        var parts=[];
        if(p.running)parts.push('<span class="ps ps-running">'+p.running+' running</span>');
        if(p.queued)parts.push('<span class="ps ps-queued">'+p.queued+' queued</span>');
        if(p.retrying)parts.push('<span class="ps ps-retrying">'+p.retrying+' retrying</span>');
        if(p.completed)parts.push('<span class="ps ps-completed">'+p.completed+' done</span>');
        if(p.failed)parts.push('<span class="ps ps-failed">'+p.failed+' failed</span>');
        if(!parts.length)parts.push('<span class="muted" style="font-size:.72rem">No tasks</span>');
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
      currentTaskData=null;
      document.getElementById('task-ttl').textContent='Task '+taskId;
      document.getElementById('task-badge').innerHTML='';
      document.getElementById('task-bd').innerHTML='<div class="muted" style="text-align:center;padding:32px">Loading\u2026</div>';
      document.getElementById('task-retry').style.display='none';
      document.getElementById('task-cancel').style.display='none';
      document.getElementById('task-edit').style.display='none';
      document.getElementById('task-overlay').style.display='flex';
      fetch('/dashboard/api/task/'+encodeURIComponent(taskId))
        .then(function(r){return r.json();})
        .then(function(t){
          currentTaskData=t;
          document.getElementById('task-badge').innerHTML=badge(t.status);
          var active=['queued','running','retrying'];
          document.getElementById('task-retry').style.display=active.includes(t.status)?'none':'';
          document.getElementById('task-cancel').style.display=active.includes(t.status)?'':'none';
          document.getElementById('task-edit').style.display=t.status==='queued'?'':'none';
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
      currentTaskData=null;
    }
    function cancelTask(){
      if(!currentTaskId)return;
      if(!confirm('Cancel task '+currentTaskId+'?'))return;
      var btn=document.getElementById('task-cancel');
      btn.disabled=true;
      fetch('/dashboard/api/task/'+encodeURIComponent(currentTaskId)+'/cancel',{method:'POST',headers:{'Content-Type':'application/json'}})
        .then(function(r){return r.json();})
        .then(function(d){
          btn.disabled=false;
          if(d.error){alert('Error: '+d.error);return;}
          closeTask();
        })
        .catch(function(){btn.disabled=false;alert('Failed to cancel task');});
    }
    function openEditTask(){
      if(!currentTaskData)return;
      document.getElementById('et-prompt').value=currentTaskData.prompt;
      document.getElementById('et-err').style.display='none';
      document.getElementById('et-submit').disabled=false;
      document.getElementById('et-overlay').style.display='flex';
      setTimeout(function(){document.getElementById('et-prompt').focus();},50);
    }
    function closeEditTask(){document.getElementById('et-overlay').style.display='none';}
    function submitEditTask(){
      var prompt=document.getElementById('et-prompt').value.trim();
      var errEl=document.getElementById('et-err');
      errEl.style.display='none';
      if(!prompt){errEl.textContent='Prompt is required.';errEl.style.display='block';return;}
      var btn=document.getElementById('et-submit');
      btn.disabled=true;
      fetch('/dashboard/api/task/'+encodeURIComponent(currentTaskId),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:prompt})})
        .then(function(r){return r.json();})
        .then(function(d){
          btn.disabled=false;
          if(d.error){errEl.textContent='Error: '+d.error;errEl.style.display='block';return;}
          closeEditTask();
          openTask(currentTaskId);
        })
        .catch(function(){btn.disabled=false;errEl.textContent='Failed to update task.';errEl.style.display='block';});
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
    function retryAllFailed(){
      if(!confirm('Retry all failed tasks?'))return;
      var btn=document.getElementById('retry-failed-btn');
      btn.disabled=true;
      fetch('/dashboard/api/tasks/retry-failed',{method:'POST',headers:{'Content-Type':'application/json'}})
        .then(function(r){return r.json();})
        .then(function(d){
          btn.disabled=false;
          if(d.error){alert('Error: '+d.error);return;}
          alert('Retried '+d.retried+' failed task(s).');
        })
        .catch(function(){btn.disabled=false;alert('Failed to retry tasks');});
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
        if(document.getElementById('et-overlay').style.display!=='none')closeEditTask();
        else if(document.getElementById('task-overlay').style.display!=='none')closeTask();
        else if(document.getElementById('nt-overlay').style.display!=='none')closeNewTask();
      }
    });
    function refreshData(){
      var btn=document.getElementById('refresh-btn');
      if(btn.disabled)return;
      btn.disabled=true;
      btn.textContent='Refreshing\u2026';
      fetch('/dashboard/api/data')
        .then(function(r){return r.json();})
        .then(function(d){
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
        })
        .catch(function(){document.getElementById('dot').className='dot err';})
        .finally(function(){btn.disabled=false;btn.textContent='\u21bb Refresh';});
    }
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
    ${THEME_TOGGLE_JS}
  </script>
</body>
</html>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

const DASH_COOKIE = "impl_dash";

export function registerDashboardRoutes(
    app: express.Express,
    taskManager: TaskManager,
    config: Config
): void {
    const adminPassword = config.server.adminPassword;

    // GET /dashboard — login form or live dashboard
    app.get("/dashboard", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.send(loginHtml());
            return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(dashboardHtml(true));
    });

    app.post("/dashboard", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        const password =
            typeof req.body?.password === "string" ? req.body.password : "";
        if (password === adminPassword) {
            const token = dashboardToken(adminPassword);
            res.setHeader(
                "Set-Cookie",
                `${DASH_COOKIE}=${token}; Path=/dashboard; HttpOnly; SameSite=Strict`
            );
            res.redirect("/dashboard");
        } else {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.send(loginHtml(true));
        }
    });

    // Logout is always available — just clears the cookie
    app.get("/dashboard/logout", (_req, res) => {
        res.setHeader(
            "Set-Cookie",
            `${DASH_COOKIE}=; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=0`
        );
        res.redirect("/dashboard");
    });

    app.get("/dashboard/events", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).send("Unauthorized");
            return;
        }
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
        const send = () =>
            res.write(
                `data: ${JSON.stringify(buildDashboardData(taskManager, config))}\n\n`
            );
        send();
        const interval = setInterval(send, 3000);
        req.on("close", () => clearInterval(interval));
    });

    app.get("/dashboard/api/data", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        res.json(buildDashboardData(taskManager, config));
    });

    app.get("/dashboard/api/task/:taskId", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const task = taskManager
            .listAllTasks()
            .find((t) => t.taskId === req.params.taskId);
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
            durationSeconds: Math.round(
                ((task.completedAt
                    ? new Date(task.completedAt).getTime()
                    : Date.now()) -
                    new Date(task.startedAt).getTime()) /
                    1000
            ),
            output:
                task.status === "queued" ||
                task.status === "running" ||
                task.status === "retrying" ||
                task.status === "interrupted"
                    ? null
                    : extractLastAssistantMessage(task.output) || null,
            error: task.error ?? null,
            pullRequests: task.pullRequests ?? null
        });
    });

    app.post("/dashboard/api/task", async (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
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
                : typeof pullRequestNumber === "string" &&
                    parseInt(pullRequestNumber, 10) > 0
                  ? parseInt(pullRequestNumber, 10)
                  : undefined;
        try {
            const task = await taskManager.startTask(projectId, {
                prompt: prompt.trim(),
                pullRequestNumber: prNum
            });
            res.json({
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

    app.post("/dashboard/api/task/:taskId/cancel", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const task = taskManager
            .listAllTasks()
            .find((t) => t.taskId === req.params.taskId);
        if (!task) {
            res.status(404).json({ error: "Task not found" });
            return;
        }
        try {
            const cancelled = taskManager.cancelTask(
                task.projectId,
                task.taskId
            );
            res.json({
                taskId: cancelled.taskId,
                branch: cancelled.branch,
                status: cancelled.status
            });
        } catch (err) {
            if (err instanceof TaskCancelError) {
                res.status(409).json({ error: err.message });
                return;
            }
            res.status(500).json({
                error:
                    err instanceof Error ? err.message : "Internal server error"
            });
        }
    });

    app.patch("/dashboard/api/task/:taskId", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const task = taskManager
            .listAllTasks()
            .find((t) => t.taskId === req.params.taskId);
        if (!task) {
            res.status(404).json({ error: "Task not found" });
            return;
        }
        const { prompt } = req.body ?? {};
        if (typeof prompt !== "string" || !prompt.trim()) {
            res.status(400).json({ error: "Prompt is required" });
            return;
        }
        try {
            const updated = taskManager.editTask(
                task.projectId,
                task.taskId,
                prompt
            );
            res.json({
                taskId: updated.taskId,
                projectId: updated.projectId,
                branch: updated.branch,
                prompt: updated.prompt,
                title: updated.title ?? null,
                status: updated.status
            });
        } catch (err) {
            if (err instanceof TaskEditError) {
                res.status(409).json({ error: err.message });
                return;
            }
            res.status(500).json({
                error:
                    err instanceof Error ? err.message : "Internal server error"
            });
        }
    });

    app.post("/dashboard/api/task/:taskId/retry", async (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const task = taskManager
            .listAllTasks()
            .find((t) => t.taskId === req.params.taskId);
        if (!task) {
            res.status(404).json({ error: "Task not found" });
            return;
        }
        try {
            const retried = await taskManager.retryTask(
                task.projectId,
                task.taskId
            );
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
                error:
                    err instanceof Error ? err.message : "Internal server error"
            });
        }
    });

    app.post("/dashboard/api/tasks/retry-failed", async (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const failedTasks = taskManager
            .listAllTasks()
            .filter((t) => t.status === "failed");
        const results = await Promise.allSettled(
            failedTasks.map((t) => taskManager.retryTask(t.projectId, t.taskId))
        );
        const retried = results.filter((r) => r.status === "fulfilled").length;
        const errors = results
            .filter((r): r is PromiseRejectedResult => r.status === "rejected")
            .map((r) =>
                r.reason instanceof Error ? r.reason.message : "Unknown error"
            );
        res.json({ retried, errors });
    });
}
