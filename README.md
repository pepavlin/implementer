# Implementer

AI Code Task Execution Service — receives coding tasks via REST API, executes them using Claude Code CLI in a Docker sandbox on configured git repositories, and provides status monitoring.

Designed to be called from n8n or any HTTP client. Only one task runs at a time.

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
  workspaceDir: ./workspace        # where repos are cloned

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

If a task is already running, you get `409`:
```json
{
  "error": "Task already running",
  "currentTask": { "taskId": "a1b2c3d4", "status": "running" }
}
```

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

### Check status

```bash
curl http://localhost:3000/task/status
```

When a task is running:
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

When idle:
```json
{
  "status": "idle",
  "lastTask": { ... }
}
```

Status values: `idle`, `running`, `completed`, `failed`.

### Get output log

```bash
curl http://localhost:3000/task/log
```

Returns the Claude Code CLI output for the current or last task:
```json
{
  "taskId": "a1b2c3d4",
  "output": "... claude code output ...",
  "truncated": false
}
```

## Git workflow

When a new task starts (no `fromBranch`), the service:

1. Clones/fetches all configured repositories
2. Checks out and pulls the default branch in each repo
3. Creates a new branch `impl/{ai-generated-slug}-{taskId}` in all repos
4. Runs Claude Code CLI in the workspace root (access to all repos)
5. Pushes the branch to remote in all repos that have changes

When continuing (`fromBranch` provided), the service checks out that branch in all repos and runs Claude Code on it.

## n8n integration

Typical n8n workflow:

1. **HTTP Request node** — `POST /task` with a prompt
2. **Wait node** — poll `GET /task/status` every 30s until status is `completed` or `failed`
3. **HTTP Request node** — `GET /task/log` to retrieve the output
4. Continue with PR creation, notifications, etc.
