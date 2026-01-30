# Implementer

AI Code Task Execution Service — receives coding tasks via REST API, executes them using Claude Code CLI on configured git repositories, and provides status monitoring.

Designed to be called from n8n or any HTTP client. Only one task runs at a time.

## Setup

```bash
npm install
```

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
    allowedTools:
      - Bash
      - Read
      - Write
      - Edit
      - Glob
      - Grep

claudeCode:
  command: claude                   # path to claude CLI binary
  model: sonnet                    # optional model override
```

You can define multiple repositories in the `repositories` array. Each task targets one repository by name.

Make sure `claude` CLI is installed and available in your PATH (or provide the full path in `claudeCode.command`).

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
    "repository": "my-project",
    "prompt": "Implement a login page with email and password fields"
  }'
```

Response (`200`):
```json
{
  "taskId": "a1b2c3d4",
  "repository": "my-project",
  "branch": "impl/a1b2c3d4",
  "status": "running"
}
```

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
    "repository": "my-project",
    "prompt": "Add form validation to the login page",
    "fromBranch": "impl/a1b2c3d4"
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
  "repository": "my-project",
  "branch": "impl/a1b2c3d4",
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

1. Clones the repo (or fetches if already cloned)
2. Checks out and pulls the default branch
3. Creates a new branch `impl/{taskId}`
4. Runs Claude Code CLI in the repo directory
5. Any commits Claude Code makes land on that branch

When continuing (`fromBranch` provided), the service checks out that branch and runs Claude Code on it.

The service does **not** push branches — Claude Code itself may push if configured to, or you can handle pushing separately in your n8n workflow.

## n8n integration

Typical n8n workflow:

1. **HTTP Request node** — `POST /task` with repository name and prompt
2. **Wait node** — poll `GET /task/status` every 30s until status is `completed` or `failed`
3. **HTTP Request node** — `GET /task/log` to retrieve the output
4. Continue with PR creation, notifications, etc.
