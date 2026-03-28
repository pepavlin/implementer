# Implementer

AI Code Task Execution Service built with TypeScript/Node.js.

## Development

- Run in dev mode: `npx tsx src/index.ts`
- Type check: `npx tsc --noEmit`
- Build: `npx tsc`
- Tests: `npx vitest run`

## Project Structure

- `src/index.ts` - Entry point, loads config and starts server
- `src/server.ts` - Express routes (POST /task, GET /task/status, GET /task/log)
- `src/config/` - Config loading, validation & project model
- `src/task-manager/` - Task state machine, runner, orchestration
- `src/git-manager.ts` - Git clone, fetch, branch, checkout operations (verifies origin URL on workspace reuse)
- `src/executor.ts` - Claude Code CLI subprocess management
- `src/workspace-pool.ts` - Workspace pool management
- `src/pr-poller.ts` - Background PR state and pipeline check polling
- `src/types.ts` - TypeScript interfaces

## GitHub Token Resolution

The effective `githubToken` for a task is resolved at creation time in `createNewTask()`:
1. Request-level token (from API body) takes highest priority
2. Chain-inherited token from parent task tip
3. Project-level `auth.githubToken` from config (fallback)

The resolved token is stored on `task.data.githubToken`. For backward compatibility, `task.getGithubToken()` still falls back to project auth.

The token is passed into the sandbox Docker container as `GITHUB_TOKEN` env var via `executor.run()`, where the Dockerfile's credential helper (`git-credential-env`) reads it at runtime for git operations performed by Claude inside the container.

## Config Environment Variable Substitution

Config values support `${ENV_VAR}` syntax for referencing environment variables. Resolution happens in `resolveEnvVars()` (in `src/config/config.ts`) before Zod validation:
- A value that is exactly `${VAR}` resolves to `process.env[VAR]`, or `undefined` if unset (omitting the key entirely so optional fields stay absent).
- A value containing `${VAR}` as part of a larger string does partial interpolation (unset vars become empty string).
- This applies recursively to all strings in the parsed YAML object.
