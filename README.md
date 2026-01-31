# Implementer

AI Code Task Execution Service — receives coding tasks via REST API, executes them using Claude Code CLI in a Docker sandbox on configured git repositories, and provides status monitoring.

Supports parallel task execution. Each task gets an isolated workspace instance, so multiple tasks can run concurrently without interfering with each other. Idle workspace instances are automatically reused.

## Setup

```bash
npm install
```

### Prerequisites

- **Docker** — must be running (Claude Code executes inside a sandboxed container)
- **Claude Code auth** — either set `CLAUDE_CODE_OAUTH_TOKEN` env var, or have Claude Code credentials stored in macOS Keychain (from a previous `claude` login)

## Configuration

Edit `config.yaml` to match your environment:

```yaml
server:
  port: 3000
  workspaceDir: ./workspace        # where workspace instances are stored

repositories:
  - name: my-project
    url: git@github.com:user/my-project.git
    defaultBranch: main

claudeCode:
  command: claude                   # path to claude CLI binary
  model: sonnet                    # optional model override
  dockerImage: implementer-sandbox  # Docker image for sandboxed execution
```

You can define multiple repositories — Claude Code runs in the workspace root with access to all of them.

The Docker image is built automatically on first startup if it doesn't exist.

## Running

```bash
npx tsx src/index.ts
```

Or with a custom config path:

```bash
npx tsx src/index.ts /path/to/config.yaml
```

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

### Continue on an existing branch

To send a follow-up task that continues from a previous branch:

```bash
curl -X POST http://localhost:3000/task \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Add form validation to the login page",
    "fromBranch": "impl/login-page-email-password-a1b2c3d4"
  }'
```

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

When a new task starts (no `fromBranch`), the service:

1. Acquires a workspace instance (reuses idle or clones fresh)
2. Checks out and pulls the default branch in each repo
3. Creates a new branch `impl/{ai-generated-slug}-{taskId}` in all repos
4. Runs Claude Code CLI in the workspace (access to all repos)
5. Pushes the branch to remote in all repos that have changes
6. Releases the workspace instance back to the pool

When continuing (`fromBranch` provided), the service checks out that branch in all repos and runs Claude Code on it.

## n8n integration

Typical n8n workflow:

1. **HTTP Request node** — `POST /task` with a prompt
2. **Wait node** — poll `GET /task/:taskId` every 30s until status is `completed` or `failed`
3. **HTTP Request node** — `GET /task/:taskId/log` to retrieve the output
4. Continue with PR creation, notifications, etc.
