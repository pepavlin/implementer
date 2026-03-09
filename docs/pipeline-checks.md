# Pipeline Check Waiting (`waitForPipeline`)

## Overview

By default, tasks are marked as `completed` as soon as a PR is created. If you want the task to wait until all CI/CD pipeline checks on the PR pass before being considered complete, enable `waitForPipeline` in your project config.

```yaml
projects:
  my-project:
    waitForPipeline: true   # wait for CI checks before completing
    repositories:
      - name: my-repo
        url: https://github.com/my-org/my-repo.git
```

## Behavior

When `waitForPipeline: true`:

1. Claude Code runs, commits are made, PR is created (normal flow).
2. Instead of transitioning to `completed`, the task moves to **`waiting_for_pipeline`** status.
3. The workspace (Docker container) is **released immediately** — the task is in a passive wait state and does not consume resources.
4. **Other tasks can start while this task is waiting** — `waiting_for_pipeline` does not count against concurrent task limits.
5. The `PrPoller` (background poller, every 5 min) checks the GitHub check runs on the PR.
6. When all checks pass → task moves to `completed`.
7. If any check fails → task moves to `failed` with the name of the failed check in the error message.

When `waitForPipeline: false` (default):

- Task moves directly from `running` to `completed` after PR is created (same behavior as before).

## Task Status

| Status | Meaning |
|--------|---------|
| `waiting_for_pipeline` | PR created, waiting for CI/CD checks to complete |
| `completed` | All pipeline checks passed (or `waitForPipeline` is disabled) |
| `failed` | A pipeline check failed |

## Pipeline Check Logic

The poller calls `gh pr checks <url> --json name,state,conclusion` for each PR on the task.

| Check state | How it's treated |
|-------------|-----------------|
| `SUCCESS`, `NEUTRAL`, `SKIPPED` | Passing |
| `FAILURE`, `ERROR`, `TIMED_OUT`, `ACTION_REQUIRED`, `CANCELLED` | Failing — task fails with the check name in the error |
| `PENDING`, empty string | Pending — keep waiting |
| No checks (empty array) | Passing — task completes immediately (no CI configured) |

If **any** check is failing, the task fails immediately. If **all** checks are passing (or there are no checks), the task completes. Otherwise, the poller keeps waiting.

## Multi-Repo Tasks

Tasks may have PRs across multiple repositories (one per repo). All PRs must have passing checks before the task completes. If any PR has a failing check, the task fails.

## Error Handling

- If the `gh pr checks` command fails due to a transient error (network issue, GitHub API rate limit), the poller logs a warning and keeps waiting — the task stays in `waiting_for_pipeline` and will be re-checked on the next poll cycle (every 5 min).
- Permanent failures (e.g. check conclusion `FAILURE`) immediately transition the task to `failed`.

## Cancellation

Tasks in `waiting_for_pipeline` status can be cancelled via the API (`POST /task/{projectId}/{taskId}/cancel`). They can also be manually retried (`POST /task/{projectId}/{taskId}/retry`), which re-queues the task to run again from the beginning.

## Architecture

| Component | File | Responsibility |
|-----------|------|----------------|
| `waitForPipeline` config | `src/config/config-types.ts` | Per-project flag |
| Transition logic | `src/task-manager/task-runner.ts` | Calls `task.waitForPipeline()` instead of `task.complete()` |
| State methods | `src/task-manager/task.ts` | `waitForPipeline()`, `completePipeline()`, `failPipeline()` |
| Pipeline polling | `src/pr-poller.ts` | `ghChecksQuery`, `analyzePipelineChecks`, `checkPipelineForTask` |
| Task transition callbacks | `src/task-manager/task-manager.ts` | `completePipelineTask()`, `failPipelineTask()` |
