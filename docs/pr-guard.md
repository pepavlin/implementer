# Pull Request Guard

## Problem

The implementer AI agent was occasionally closing pull requests after creating them. This was caused by the agent interpreting task instructions in a way that led it to run `gh pr close` or `gh pr merge` as part of its work — despite a system-prompt rule prohibiting it.

## Solution

A two-layer defence was implemented:

### Layer 1: Technical enforcement — `gh-pr-guard` hook

A Claude Code `PreToolUse` hook is configured in every workspace's `.claude/settings.json`. Before any Bash command runs, Claude Code invokes `/usr/local/bin/gh-pr-guard` (installed in the sandbox image via `Dockerfile.sandbox`).

The script parses the tool-call JSON from stdin and exits with code `2` (block) if the command matches:

```
gh pr close
gh pr merge
gh pr delete
```

When blocked, Claude Code receives a clear error message explaining that these operations are forbidden, so the model stops trying.

### Layer 2: Stronger system prompt

The system instruction in `buildSystemInstructions` (task-manager.ts) was reworded to:
- Explicitly list all three forbidden commands.
- Mention that a *technical enforcement layer* will block them even if the model tries.
- Clarify that `gh pr create` is also handled by the system automatically, so the model should not run it either.

## Architecture

```
Task execution flow
───────────────────
executor.run(prompt, ...)
  └─ Docker sandbox container
       ├─ /usr/local/bin/gh-pr-guard  (installed in Dockerfile.sandbox)
       └─ Claude Code CLI
            └─ Workspace: .claude/settings.json  ← written by WorkspacePool.writeMcpConfig()
                 └─ hooks.PreToolUse[matcher=Bash] → gh-pr-guard
```

`WorkspacePool.writeMcpConfig()` always writes `.claude/settings.json` with the hook, regardless of whether MCP servers are configured. When MCP servers are present, it additionally writes `.mcp.json` and sets `enableAllProjectMcpServers: true`.

## Files changed

| File | Change |
|------|--------|
| `gh-pr-guard.sh` | New hook script; blocks `gh pr close/merge/delete` |
| `Dockerfile.sandbox` | Copies `gh-pr-guard.sh` to `/usr/local/bin/gh-pr-guard` |
| `src/workspace-pool.ts` | Always writes `.claude/settings.json` with the hook |
| `src/task-manager.ts` | Strengthened system-prompt wording |
| `src/workspace-pool.test.ts` | Tests for hook configuration |
| `src/task-manager.test.ts` | Added test for `gh pr delete` and enforcement mention |
