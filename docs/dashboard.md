# Dashboard

The Implementer Dashboard is a built-in web UI served at `/dashboard`. It requires `adminPassword` to be set in the server configuration.

## Authentication

The dashboard uses a cookie-based session (`impl_dash`). On successful login, a SHA-256 hash of the admin password is stored as a cookie. The cookie is scoped to `/dashboard`, HttpOnly, and SameSite=Strict.

## Features

- **Live task stream** — uses Server-Sent Events (`/dashboard/events`) to push updates every 2 seconds
- **Manual refresh** — a Refresh button forces an immediate reload of all task states
- **Project cards** — shows per-project task counts; click to filter the task list
- **Status filters** — filter tasks by status (running, queued, retrying, completed, failed, interrupted, open PRs)
- **Task detail modal** — view full task info including prompt, output, error, branch, and pull requests with their current state
- **New Task modal** — submit a new task from the UI, selecting project and writing a prompt
- **Retry task** — retry a failed or interrupted task from the task detail modal
- **Light/dark mode toggle** — theme preference persisted in `localStorage` under the key `impl-theme`
- **Pull request state tracking** — PRs show their current state (open, draft, merged, closed) with color-coded badges
- **Open PRs counter** — a dedicated stat card shows the count of open/draft PRs; clicking it filters to tasks with open PRs
- **Open PR row highlighting** — tasks with open or draft pull requests have a distinct left-border highlight in the task table
- **Task duration progress bar** — running tasks with an AI-estimated duration show a linear progress bar in the task list row, indicating what percentage of the estimated time has elapsed. The bar turns amber when the task exceeds the estimate.
- **Cross-device read/unread tracking** — completed tasks show a pulsing "new" indicator until they are opened. This read status is persisted on the server (as `readAt` on the task) and shared across all browsers and devices, not stored in localStorage.
- **Task priority** — tasks can be assigned a priority level (`low`, `normal`, `high`, `critical`). Higher-priority tasks are dequeued before lower-priority ones. Within the same priority level, FIFO order is preserved. Priority is set when creating a task (via the New Task modal or API) and can be changed at any time from the task detail modal.
- **Global queue pause/resume** — a "Pause" button in the header stops new tasks from being started. Tasks already running continue to completion. A prominent yellow banner is shown when the queue is paused. Clicking "Resume" (or the banner button) re-enables dequeuing and immediately starts any eligible queued tasks.

## Light/Dark Mode

The dashboard supports both dark mode (default) and light mode. A toggle button (☀/☾) appears in the header of both the login page and the main dashboard.

### Implementation

Theming is implemented using CSS custom properties (variables):

- `:root` defines all dark-mode color values
- `[data-theme=light]` overrides the same variables with light-mode values
- The `<html>` element receives `data-theme="light"` when light mode is active
- A small inline script at the top of `<head>` reads `localStorage` and applies the `data-theme` attribute **before** the page renders, preventing a flash of unstyled content (FOUC)
- `localStorage.setItem('impl-theme', 'light')` persists the preference across page loads and navigation between login/dashboard

### CSS Variable Reference

| Variable | Dark | Light | Usage |
|---|---|---|---|
| `--bg` | `#0f1117` | `#f8fafc` | Page background |
| `--bg-card` | `#1e2130` | `#ffffff` | Cards, modals, table |
| `--bg-head` | `#161925` | `#f1f5f9` | Table header |
| `--bg-code` | `#0f1117` | `#f1f5f9` | Pre/code blocks |
| `--bg-inp` | `#0f1117` | `#ffffff` | Form inputs |
| `--border` | `#252a3a` | `#e2e8f0` | Primary borders |
| `--border2` | `#2a2f42` | `#cbd5e1` | Secondary borders |
| `--text` | `#e2e8f0` | `#0f172a` | Primary text |
| `--text2` | `#94a3b8` | `#475569` | Secondary text |
| `--text3` | `#64748b` | `#64748b` | Tertiary text |
| `--text4` | `#4a5568` | `#94a3b8` | Muted/hint text |
| `--b-run-bg/fg` | dark green | light green | Running badge |
| `--b-q-bg/fg` | dark amber | light amber | Queued badge |
| `--b-ret-bg/fg` | dark blue | light blue | Retrying badge |
| `--b-fail-bg/fg` | dark red | light red | Failed badge |
| `--b-int-bg/fg` | dark purple | light purple | Interrupted badge |

## Voice Mode

Voice Mode allows submitting tasks to a project by dictating them with the browser's Web Speech API (Chrome/Chromium required).

### Activation

Click the 🎤 button in the header to toggle Voice Mode. A fixed bottom panel appears with status and controls.

### Usage flow

1. **Select project** — click any project card while in Voice Mode to start recording for that project.
2. **Dictate** — speech is transcribed in real time in the transcript area.
3. **Submit** — task is sent via one of two methods:
   - **Send button** — click the green `✓ Send` button that appears as soon as speech is detected, for immediate submission.
   - **Auto-submit** — after 4 seconds of silence the task is submitted automatically (progress shown by the silence countdown bar).
4. **Cancel** — click `✕ Cancel` to discard the current transcript without submitting.

### Controls

| Control | Function |
|---|---|
| `cs-CZ / en-US` button | Toggle recognition language |
| `✓ Send` button | Submit the current transcript immediately (visible only when transcript is non-empty) |
| `✕ Cancel` button | Discard transcript and stop recording |

### JavaScript API

| Function | Description |
|---|---|
| `toggleVoiceMode()` | Show/hide voice panel |
| `voiceSelectProject(id)` | Start recording for a project |
| `voiceSendNow()` | Clear silence timer and submit transcript immediately |
| `voiceAutoSubmit()` | POST transcript to `/dashboard/api/task` |
| `voiceCancel()` | Discard transcript and stop recording |
| `updateVoicePanel()` | Sync UI state (status text, send/cancel button visibility) |

## Read/Unread Task Tracking

Completed tasks display a pulsing indicator badge ("✓ Completed" with a green dot) until they are opened. Once a user opens the task detail modal, the task is marked as read.

### How it works

- Opening a task detail modal triggers a `POST /dashboard/api/task/:taskId/read` request.
- The server stores an ISO timestamp `readAt` directly on the `TaskData` object and persists it to disk.
- All subsequent dashboard API responses (`/dashboard/api/data`, SSE events) include `readAt` for each task.
- The frontend uses `t.readAt` from the server response to determine unread status — no localStorage is involved.

### Benefits

- **Cross-device**: Opening a task on one device marks it as read on all other devices automatically (next SSE refresh).
- **Persistent**: Read status survives browser clear, incognito mode, and new browsers.

### API

| Endpoint | Method | Description |
|---|---|---|
| `/dashboard/api/task/:taskId/read` | `POST` | Mark task as read. Idempotent. Returns `{ taskId, readAt }`. |
