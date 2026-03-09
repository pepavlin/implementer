# Pipeline Handling (`handlePipelines`)

## Overview

By default, tasks are marked as `completed` as soon as a PR is created. The `handlePipelines` config section enables monitoring of specific CI/CD pipeline jobs on the PR, and automatically re-triggers the implementer to fix the code when any of those jobs fail.

```yaml
projects:
  my-project:
    handlePipelines:
      # CI/CD pipeline job names to monitor (required, at least one)
      pipelines:
        - build
        - test
        - lint
      # How many automatic fix attempts to allow when a pipeline fails.
      # Defaults to 1. Set to 0 to disable auto-retry (only wait and fail).
      retryCount: 1
    repositories:
      - name: my-repo
        url: https://github.com/my-org/my-repo.git
```

## Behavior

When `handlePipelines` is configured:

1. Claude Code runs, commits are made, PR is created (normal flow).
2. Instead of transitioning to `completed`, the task moves to **`waiting_for_pipeline`** status.
3. The workspace (Docker container) is **released immediately** — the task is in a passive wait state and does not consume resources.
4. **Other tasks can start while this task is waiting** — `waiting_for_pipeline` does not count against concurrent task limits.
5. The `PrPoller` (background poller, every 5 min) checks the GitHub check runs on the PR, **only evaluating the jobs listed in `pipelines`** — all others are ignored.
6. When all watched pipeline jobs pass → task moves to `completed`.
7. If any watched pipeline job fails:
   - If the pipeline retry limit has not been reached (`pipelineRetryAttempt < retryCount`):
     - The failing task is marked as `failed`.
     - A new **continuation task** is automatically created on the **same branch**, with a prompt explaining which pipeline job failed and instructions to fix it.
     - The new task also enters `waiting_for_pipeline` after its PR update, repeating the cycle.
   - If the retry limit is reached → task is marked as `failed` (no more automatic retries).

When `handlePipelines` is not configured (default):

- Task moves directly from `running` to `completed` after PR is created.

## Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `handlePipelines.pipelines` | `string[]` | required | List of CI/CD job names to monitor. At least one name is required. |
| `handlePipelines.retryCount` | `number` | `1` | Number of automatic fix attempts when a pipeline fails. `0` = wait-only (fail without auto-retry). |

## Task Status

| Status | Meaning |
|--------|---------|
| `waiting_for_pipeline` | PR created/updated, waiting for listed CI/CD jobs to complete |
| `completed` | All listed pipeline jobs passed |
| `failed` | A listed pipeline job failed and the retry limit was reached |

## Pipeline Name Filtering

The poller calls `gh pr checks <url> --json name,state,conclusion` for each PR and then filters the results to **only the job names listed in `handlePipelines.pipelines`**. Jobs not in the list are completely ignored, whether they pass or fail.

If none of the listed jobs have appeared yet (e.g. they haven't started), the status is treated as **pending** — the task keeps waiting until they appear.

| Matched check state | How it's treated |
|---------------------|-----------------|
| `SUCCESS`, `NEUTRAL`, `SKIPPED` | Passing |
| `FAILURE`, `ERROR`, `TIMED_OUT`, `ACTION_REQUIRED`, `CANCELLED` | Failing → triggers retry or failure |
| `PENDING`, empty string | Pending — keep waiting |
| No matching checks found yet | Pending — keep waiting for listed jobs to appear |
| No checks at all (empty array, no filter) | Passing — no CI configured |

## Automatic Pipeline Fix Retry

When a watched pipeline job fails and retries remain:

1. The failing task is marked as `failed` with error `Pipeline check failed: <job-name>`.
2. A new task is automatically created with `continueTaskId` pointing to the failing task (same branch).
3. The fix task's prompt includes:
   - Which pipeline job failed
   - Instructions to review the CI output and fix the code
   - A list of the required passing pipeline jobs
4. The new task has `pipelineRetryAttempt` incremented (tracks retry depth).
5. When the fix task eventually creates/updates the PR, it re-enters `waiting_for_pipeline`.

## Multi-Repo Tasks

Tasks may have PRs across multiple repositories (one per repo). All PRs must have passing watched checks before the task completes. If any PR has a failing watched check, the pipeline failure handler is triggered.

## Error Handling

- If the `gh pr checks` command fails due to a transient error (network issue, GitHub API rate limit), the poller logs a warning and keeps waiting — the task stays in `waiting_for_pipeline` and will be re-checked on the next poll cycle.
- Permanent failures (job conclusion `FAILURE` etc.) immediately trigger the retry/fail logic.

## Cancellation and Manual Retry

Tasks in `waiting_for_pipeline` status can be cancelled via the API (`POST /task/{projectId}/{taskId}/cancel`). They can also be manually retried (`POST /task/{projectId}/{taskId}/retry`), which re-queues the task to run again.

## Architecture

| Component | File | Responsibility |
|-----------|------|----------------|
| `handlePipelines` config | `src/config/config-types.ts` | Per-project pipeline monitoring config |
| Transition logic | `src/task-manager/task-runner.ts` | Calls `task.waitForPipeline()` instead of `task.complete()` when `handlePipelines` is set |
| State methods | `src/task-manager/task.ts` | `waitForPipeline()`, `completePipeline()`, `failPipeline()` |
| Pipeline polling | `src/pr-poller.ts` | `ghChecksQuery`, `analyzePipelineChecks` (with name filter), `checkPipelineForTask` |
| Pipeline failure handling | `src/task-manager/task-manager.ts` | `completePipelineTask()`, `handlePipelineFailure()` (retry or fail) |
| Pipeline retry tracking | `src/types.ts` | `pipelineRetryAttempt` field on `TaskData` |
