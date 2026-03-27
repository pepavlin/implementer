# Dynamic Repositories

## Overview

Tasks can be submitted with a custom `repoUrl` and `githubToken` instead of using a project's preconfigured repositories. This allows a single "template" project (with empty `repositories: []`) to serve tasks for any GitHub repository.

## How It Works

When creating a task via `POST /task`:

```json
{
  "prompt": "Fix the bug",
  "repoUrl": "https://github.com/org/repo.git",
  "githubToken": "ghp_xxx"
}
```

- `repoUrl` — the repository to clone and work on
- `githubToken` — GitHub token for clone, push, and PR operations (can be a PAT or fine-grained token)

The project must have no preconfigured repositories (`repositories: []`). If the project has repos configured, using `repoUrl` will return a 400 error.

## Credential Lifecycle

The `githubToken` is stored on the task data (`task.data.githubToken`) and persisted to disk. It is used throughout the entire task lifecycle:

1. **Workspace acquisition** — `pool.acquire()` passes the token to `ensureAllRepos()` and `resetToDefaultAll()` for git clone/fetch operations
2. **Branch operations** — checkout, push, rebase all use the token via per-command git header injection (`http.extraHeader`)
3. **PR creation** — the `gh` CLI receives the token via `GH_TOKEN` environment variable
4. **PR polling** — the PR poller uses the task's token for checking PR state and pipeline checks
5. **Retry** — both manual retry (`task.retry()`) and automatic errorRetry preserve the token
6. **Chain continuation** — child tasks inherit `repoUrl` and `githubToken` from the chain tip
7. **Pipeline fix tasks** — automatic pipeline-fix tasks forward the token from the failing task

## Workspace Reuse and Origin Verification

When a workspace is reused (pool returns a previously allocated workspace instance), `ensureAllRepos()` verifies that the git remote `origin` URL matches the requested `repoUrl`. If the URLs differ (e.g., the workspace was previously used by a different dynamic task), the repository is re-cloned from scratch. This prevents git operations from targeting the wrong repository after retry or workspace reuse.

URL comparison is normalized (`.git` suffix stripped, case-insensitive) to avoid false mismatches.

## Retry Behaviour

When a dynamic task is retried (manual or automatic):
- `repoUrl` and `githubToken` remain on the task data (never cleared)
- `getGithubToken()` returns the task-level token, falling back to the project's `auth.githubToken` if unset
- `getRepositories()` generates a single-repo config from the stored `repoUrl`
- The workspace pool re-clones if the origin URL doesn't match (workspace may have been used by another task in between)
