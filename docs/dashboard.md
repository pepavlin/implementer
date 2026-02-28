# Dashboard

The Implementer Dashboard is a built-in web UI served at `/dashboard`. It requires `adminPassword` to be set in the server configuration.

## Architecture

The dashboard is implemented as a **React SPA** (`src/frontend/`) built with Vite. During `npm run build`, Vite compiles the React components to `dist/frontend/`. The Express backend then serves `dist/frontend/index.html` for `GET /dashboard` and serves static assets from `dist/frontend/assets/`.

If the React build has not been produced (e.g. running the backend only during development), the server falls back to a legacy server-rendered HTML template.

### Directory Structure

```
src/frontend/
├── index.html              # Vite entry point
├── vite.config.ts          # Vite configuration (base: /dashboard/, outDir: dist/frontend)
├── tsconfig.json           # Frontend TypeScript config
└── src/
    ├── main.tsx            # React entry point
    ├── App.tsx             # Root component with auth state
    ├── index.css           # Global CSS with dark/light theme variables
    ├── types.ts            # Shared TypeScript types
    ├── api/
    │   └── client.ts       # API client for all /dashboard/api/* calls
    ├── hooks/
    │   └── useDashboard.ts # Polling hook, auth state, login/logout
    └── components/
        ├── LoginPage.tsx   # Login form
        ├── DashboardPage.tsx # Main layout with header, filters, task list
        ├── StatsCards.tsx  # Stats overview cards
        ├── TaskCard.tsx    # Individual task row
        ├── TaskModal.tsx   # Task detail modal
        ├── VoiceMode.tsx   # Voice recording/submission panel
        └── NewTaskForm.tsx # Quick task creation form
```

### Build Commands

| Command | Description |
|---|---|
| `npm run build` | Build backend (tsc) AND frontend (vite) |
| `npm run build:frontend` | Build only the React frontend |
| `npm run build:backend` | Build only the TypeScript backend |
| `npm run dev:frontend` | Run Vite dev server (proxies API to localhost:3000) |

## Authentication

The dashboard uses a cookie-based session (`impl_dash`). On successful login, a SHA-256 hash of the admin password is stored as a cookie. The cookie is scoped to `/dashboard`, HttpOnly, and SameSite=Strict.

### Auth API Endpoints

- `POST /dashboard/api/login` — JSON body `{password}`, sets cookie and returns `{success: true}` or 401
- `GET /dashboard/logout` — clears the cookie and redirects to `/dashboard`

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
