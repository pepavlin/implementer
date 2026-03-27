# Implementer

AI Code Task Execution Service built with TypeScript/Node.js.

## Development

- Run in dev mode: `npx tsx src/index.ts`
- Type check: `npx tsc --noEmit`
- Build: `npx tsc`

## Project Structure

- `src/index.ts` - Entry point, loads config and starts server
- `src/server.ts` - Express routes (POST /task, GET /task/status, GET /task/log)
- `src/config.ts` - Config loading & validation from config.yaml
- `src/task-manager.ts` - Task state machine, locking, orchestration
- `src/git-manager.ts` - Git clone, fetch, branch, checkout operations (verifies origin URL on workspace reuse)
- `src/executor.ts` - Claude Code CLI subprocess management
- `src/types.ts` - TypeScript interfaces
