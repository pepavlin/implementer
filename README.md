# Implementer

AI Code Task Execution Service — receives coding tasks via REST API, executes them using Claude Code CLI in a Docker sandbox on configured git repositories, and provides status monitoring.

Supports parallel task execution. Each task gets an isolated workspace instance, so multiple tasks can run concurrently without interfering with each other. Idle workspace instances are automatically reused. Tasks linked to the same pull request number always run sequentially — the next task waits until the previous one finishes.

## Setup

```bash
npm install
```

### Prerequisites

- **Docker** — must be running (Claude Code executes inside a sandboxed container)
- **Claude Code auth** — configure auth per project in `config.yaml`, or use Claude Code credentials stored in macOS Keychain (from a previous `claude` login)

## Configuration

Edit `config.yaml` to match your environment:

```yaml
server:
    workspaceDir: ./workspace # where workspace instances are stored
    maxConcurrentTasks: 10 # global cap across all projects (optional)

# Global defaults merged into every project's claudeCode (optional)
# defaults:
#     systemPrompt: |
#         Global instructions applied to all projects.
#     mcpServers:
#         playwright:
#             command: npx
#             args: ["@playwright/mcp@latest", "--headless"]

projects:
    demo-webapp:
        maxConcurrentTasks: 2
        repositories:
            - name: demo-webapp
              url: git@github.com:user/demo-webapp.git
              defaultBranch: main
        auth:
            claudeOauthToken: claude-oauth-demo-webapp
            githubToken: ghp_your_github_token
        claudeCode:
            command: claude # path to claude CLI binary
            model: sonnet # optional model override
        # protectedPaths:  # optional — paths Claude must not modify
        #     - .github
        #     - Dockerfile
        #     - docker-compose.yml
```

`defaults` fields are merged into each project's `claudeCode`: `systemPrompt` is concatenated (global first, then project), `mcpServers` are shallow-merged (project keys override global).

You can define multiple projects and multiple repositories per project.

### Protected paths

Use `protectedPaths` to prevent Claude from modifying sensitive files or directories. Changes to these paths are reverted at the git level before any PR is created, regardless of what Claude did. Supports exact filenames, directories, and git pathspec glob patterns:

```yaml
projects:
    my-project:
        protectedPaths:
            - .github          # entire .github/ directory
            - Dockerfile
            - docker-compose.yml
            - docker-compose*.yml  # glob pattern
```

### Monitor CI/CD pipelines and auto-fix failures

Configure `handlePipelines` on a project to monitor specific CI/CD pipeline jobs on the PR and automatically re-trigger the implementer when any of them fail. The workspace is released immediately after the PR is created — other tasks can start while this task waits.

```yaml
projects:
    my-project:
        handlePipelines:
            pipelines:        # CI/CD job names to watch (required)
                - build
                - test
                - lint
            retryCount: 1     # automatic fix attempts on failure (default: 1, use 0 to disable)
        repositories:
            - name: my-repo
              url: git@github.com:user/my-repo.git
```

The background PR poller (every 5 min) checks `gh pr checks` for tasks in `waiting_for_pipeline` status, filtering results to only the listed job names. When all listed jobs pass, the task completes. When a listed job fails and retries remain, a new continuation task is automatically queued on the same branch with a prompt to fix the failing pipeline. If the retry limit is reached, the task is marked `failed`.

### GitHub webhooks (real-time PR/pipeline updates)

By default, the PR poller checks GitHub every 5 minutes. To get instant updates when a PR status or CI pipeline changes, configure a GitHub webhook that points to the implementer:

```yaml
projects:
    my-project:
        webhookSecret: your-webhook-secret   # same secret configured in GitHub
        repositories:
            - name: my-repo
              url: git@github.com:user/my-repo.git
```

Then in your GitHub repository settings (Settings > Webhooks > Add webhook):

- **Payload URL:** `https://your-implementer-host/webhook/github/my-project`
- **Content type:** `application/json`
- **Secret:** same value as `webhookSecret` in config
- **Events:** Select "Let me select individual events" and enable:
  - Pull requests
  - Check runs
  - Check suites
  - Workflow runs

When a relevant event arrives (PR opened/closed/synchronized, CI check completed, workflow finished), the implementer immediately re-polls that project's tasks instead of waiting for the next 5-minute cycle. Irrelevant events (labels, assignments, etc.) are acknowledged but ignored.

The webhook endpoint uses HMAC SHA-256 signature verification — no Bearer token is needed. The regular 5-minute polling continues as a fallback in case webhook delivery fails.

`apiKey` is configured per project (`projects.<projectId>.apiKey`), not as a single global top-level config field.

Config is validated both at startup and via:

```bash
npm run check
```

The same validation logic is used in both cases, and unknown fields are rejected (strict schema).

## Running

### With Docker (recommended)

1. Copy the example config and edit it:

```bash
cp config.example.yaml config.yaml
```

2. Create a minimal `.env` file from template:

```bash
cp .env.example .env
```

Then keep only runtime values in `.env`:

```bash
INSTANCE_NAME=implementer          # unique name for this instance (affects container/image/volume names)
PORT=3000                          # optional, defaults to 3000
```

For multi-project setups, define each project's auth directly in `config.yaml` (recommended), for example:

```yaml
projects:
    demo-webapp:
        apiKey: demo-webapp-secret
        auth:
            claudeOauthToken: claude-oauth-demo-webapp
            githubToken: ghp-demo-webapp
    backend-service:
        apiKey: backend-secret
        auth:
            claudeOauthToken: claude-oauth-backend
            githubToken: ghp-backend
```

If you prefer secrets from environment, you can still use `${...}` interpolation in `config.yaml`, but it is optional.

3. Build and start:

```bash
docker compose --profile build-only build   # build the sandbox image
docker compose up -d --build                # start the service
```

This builds two images:

- **{INSTANCE_NAME}** — the main service (default: `implementer`)
- **{INSTANCE_NAME}-sandbox** — the isolated environment where Claude Code runs (default: `implementer-sandbox`)

The API is available at `http://localhost:3000`. Swagger docs at `http://localhost:3000/docs`.

To rebuild after config changes:

```bash
docker compose up -d --build
```

To view logs:

```bash
docker compose logs -f
```

### Running multiple instances

To run multiple instances with different configurations, create separate directories each with their own `config.yaml` and `.env` file. Set a unique `INSTANCE_NAME` and `PORT` in each `.env`:

**Instance A (`.env`):**

```bash
INSTANCE_NAME=impl-project-a
PORT=3000
```

**Instance B (`.env`):**

```bash
INSTANCE_NAME=impl-project-b
PORT=3001
```

Each instance gets its own containers, sandbox image, and workspace volume — they don't interfere with each other.

### Without Docker

```bash
npx tsx src/index.ts
```

Or with a custom config path:

```bash
npx tsx src/index.ts /path/to/config.yaml
```

Docker must still be running — sandbox containers are launched via the Docker socket.

## API

### Start a task

```bash
curl -X POST http://localhost:3000/task \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Implement a login page with email and password fields"
  }'
```

Response (`200`):

```json
{
    "taskId": "a1b2c3d4",
    "branch": "impl/login-page-email-password-a1b2c3d4",
    "status": "running"
}
```

The branch name is generated automatically by AI based on the prompt.

Multiple tasks can run simultaneously — each gets its own isolated workspace instance.

### Continue work on an existing pull request

To send a follow-up task that adds more commits to an existing PR:

```bash
curl -X POST http://localhost:3000/task \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Add form validation to the login page",
    "pullRequestNumber": 42
  }'
```

The service fetches the PR's head branch from GitHub and continues work there. Multiple tasks with the same `pullRequestNumber` are automatically queued and run **sequentially** — the next task starts only after the previous one finishes, so commits are never interleaved.

This also applies to retried tasks: calling `POST /task/:taskId/retry` on a PR-linked task queues it if the same PR is currently being worked on.

### List all tasks

```bash
curl http://localhost:3000/tasks
```

Response:

```json
{
    "tasks": [
        {
            "taskId": "a1b2c3d4",
            "branch": "impl/login-page-a1b2c3d4",
            "prompt": "Implement a login page",
            "status": "completed",
            "startedAt": "2026-01-30T12:00:00.000Z",
            "completedAt": "2026-01-30T12:05:00.000Z"
        },
        {
            "taskId": "e5f6g7h8",
            "branch": "impl/dashboard-e5f6g7h8",
            "prompt": "Build a dashboard",
            "status": "running",
            "startedAt": "2026-01-30T12:03:00.000Z",
            "completedAt": null
        }
    ]
}
```

### Get task status

```bash
curl http://localhost:3000/task/:taskId
```

Response:

```json
{
    "taskId": "a1b2c3d4",
    "branch": "impl/login-page-email-password-a1b2c3d4",
    "prompt": "Implement a login page",
    "status": "running",
    "startedAt": "2026-01-30T12:00:00.000Z",
    "completedAt": null
}
```

Status values: `running`, `completed`, `failed`.

### Get task output log

```bash
curl http://localhost:3000/task/:taskId/log
```

Returns the Claude Code CLI output for the specified task:

```json
{
    "taskId": "a1b2c3d4",
    "output": "... claude code output ...",
    "truncated": false
}
```

## Workspace pooling

Each task runs in an isolated workspace instance under `workspace/instances/`:

```
workspace/
  └── instances/
      ├── 0/
      │   └── my-project/    ← full clone
      ├── 1/
      │   └── my-project/    ← full clone
      └── 2/
          └── my-project/    ← created on demand
```

When a task starts, the service either reuses a free workspace (resetting repos to their default branch) or creates a new one by cloning all repositories. When a task finishes, its workspace is released back to the pool for reuse.

## Git workflow

### New task (no `pullRequestNumber`)

1. Acquires a workspace instance (reuses idle or clones fresh)
2. Checks out and pulls the default branch in each repo
3. Creates a new branch `impl/{ai-generated-slug}-{taskId}` in all repos
4. Runs Claude Code CLI in the workspace (access to all repos)
5. Pushes the branch and creates a pull request
6. Releases the workspace instance back to the pool

### PR task (`pullRequestNumber` provided)

1. Fetches the head branch of the given PR from GitHub
2. Acquires a workspace instance and checks out that branch
3. Runs Claude Code CLI on top of the existing PR commits
4. Force-pushes the updated branch — the open PR is updated automatically
5. Releases the workspace instance back to the pool

Tasks for the same PR are always serialised: a second task waits in the queue until the first one completes.

## Server restart recovery

Task state is persisted to disk so the service survives restarts. On startup the following happens automatically:

| State before restart | State after restart |
|---|---|
| `running` | Resumed immediately on the same branch. If the resumed attempt fails, the retry fires with **no delay** (delay = 0 s) so the task gets back to work right away instead of waiting for the configured `errorRetry.delaySeconds`. Subsequent automatic retries use the normal configured delay. |
| `retrying` (waiting for the delay timer) | Re-queued immediately — the remaining delay is dropped. |
| `queued` | Stays queued and runs as soon as capacity is available. |
| `waiting_for_pipeline` | Stays in `waiting_for_pipeline` — the PR poller will resume monitoring pipeline checks on the next poll cycle. |

This means tasks that were in flight when the server stopped will restart automatically without getting stuck in a long retry wait.

## Admin Dashboard

The admin dashboard is available at `/dashboard` when `server.adminPassword` is set in `config.yaml`:

```yaml
server:
    workspaceDir: ./workspace
    adminPassword: your-secure-password
```

### Features

- **Live task list** — auto-refreshes every 3 seconds via Server-Sent Events; shows status, project, title, prompt preview, duration, and start time
- **Task detail modal** — click any task row to see the full prompt, branch, duration, PR links, error, and output
- **Retry task** — retry any completed, failed, or interrupted task directly from the task detail modal
- **Create new task** — click **+ New Task** to open a form where you select a project, enter a prompt, and optionally link a pull request number
- **Project filter** — click project cards to filter the task list to one or more projects; click again to deselect; the new-task form pre-selects the currently filtered project
- **Status filter** — filter tasks by status: All, Running, Queued, Retrying, Completed, Failed, Interrupted

### Dashboard-only API routes (requires admin auth cookie)

| Route | Method | Description |
|---|---|---|
| `/dashboard/api/task/:taskId` | GET | Full task details (prompt, output, error, PRs) |
| `/dashboard/api/task` | POST | Create a new task (`{ projectId, prompt, pullRequestNumber? }`) |
| `/dashboard/api/task/:taskId/retry` | POST | Retry a task across all projects |

These routes are separate from the project Bearer-token API and use the same cookie-based auth as the dashboard UI.

## n8n integration

Typical n8n workflow:

1. **HTTP Request node** — `POST /task` with a prompt
2. **Wait node** — poll `GET /task/:taskId` every 30s until status is `completed` or `failed`
3. **HTTP Request node** — `GET /task/:taskId/log` to retrieve the output
4. Continue with PR creation, notifications, etc.
