# Task Execution & Reliability

## Overview

Tasks are executed by spawning a Docker container that runs Claude Code CLI against an isolated workspace. The `Executor` class manages this lifecycle.

## Execution Timeout

**Problem addressed:** Without a timeout, a task that hangs (e.g., Claude Code waiting for a tool response that never arrives, an infinite loop, or a network stall) would remain in `running` status indefinitely. The workspace slot would be occupied forever, and no retry or failure would ever trigger.

**Solution:** `timeoutSeconds` in `claudeCode` config sets a wall-clock limit per executor run. It **defaults to 3600 (1 hour)** — you do not need to set it manually unless you want a different value.

```yaml
claudeCode:
  # timeoutSeconds: 3600  # default — omit to keep the 1-hour limit
```

When the timeout fires:
1. A `[TIMEOUT]` message is appended to the task output so it's visible in logs/dashboard.
2. `executor.kill()` is called, which:
   - Sends `SIGTERM` to the `docker run` child process.
   - Calls `docker kill <containerName>` directly for reliability (handles cases where signal forwarding fails).
3. The container exits with a non-zero code (typically 137).
4. The task is automatically set to **`retrying`** status. Its branch is preserved so the next run can continue exactly where it left off.
5. On the next server restart (or manual `/retry` call) the task is re-queued and resumes on the same branch.

**Key difference from a regular failure:** A regular failure (non-zero exit, not a timeout) goes to `failed` and only retries if `errorRetry` is configured. A timeout always goes to `retrying`, regardless of the `errorRetry` setting, because the task simply ran out of time rather than encountering a permanent error.

## Kill Reliability

The `kill()` method was improved to always kill the Docker container by name in addition to sending SIGTERM to the Node child process. This ensures the container stops even if:
- The `docker run` process is slow to forward signals.
- The container process ignores SIGTERM.

## Retry on Timeout vs Regular Errors

Timeout and regular failures are handled differently:

| Scenario | Status after | Retry behaviour |
|---|---|---|
| Timeout (any config) | `retrying` | Resumes on same branch after server restart or manual `/retry` |
| Regular failure + `errorRetry` configured | `retrying` | Scheduled delay then auto-retry |
| Regular failure, no `errorRetry` | `failed` | No automatic retry; manual `/retry` resets |

Configure `errorRetry` for regular error retries (separate from timeout):

```yaml
errorRetry:
  maxAttempts: 3       # 1 original + 2 retries
  delaySeconds: 60     # Wait 1 minute before retrying
```

## Task State Machine

```
queued → starting → running → completed
                  ↓          ↓
               retrying ← failed (if retries configured)
                  ↓
               running → ...

                  running → waiting_for_pipeline → completed
                                                  ↓
                                                failed (if a check fails)
```

States:
- `starting` – metadata (branch slug, title) being generated
- `queued` – waiting for a free workspace slot
- `running` – Docker container active
- `retrying` – either: (a) waiting for `delaySeconds` before next auto-retry, or (b) timed out, waiting for server restart or manual `/retry`
- `waiting_for_pipeline` – Claude finished, PR created, waiting for CI/CD pipeline checks to pass (only when `waitForPipeline: true` is set in project config); workspace is released, other tasks can start
- `completed` – Claude exited 0, PR created (and pipeline passed if `waitForPipeline` is set)
- `failed` – terminal failure (all retries exhausted or no retry configured; never set on timeout; also set when `waitForPipeline` is on and a pipeline check fails)
- `interrupted` – server restarted while task was running; will be resumed on next boot
- `cancelled` – manually cancelled via API

## Crash Recovery

On server restart:
- `running` → `interrupted`: task resumes immediately on its existing branch; first post-restart failure skips the normal retry delay.
- `retrying` → `queued`: dropped delay, retried as soon as capacity is available.
- `queued` → `queued`: stays in queue, re-enqueued on startup.

## Task Duration Estimation

When metadata (branch slug + title) is generated before a task runs, the same Claude Haiku call also produces an estimated duration for the task. The estimate is a rough heuristic:

| Complexity | Estimated seconds |
|---|---|
| Trivial (1-liner fix) | ~60s |
| Simple | ~180s |
| Medium | ~600s |
| Complex | ~1800s |
| Very complex | ~3600s |

The estimate is stored as `estimatedDurationSeconds` on the task and persisted to disk. The admin dashboard uses it to render a **progress bar** next to running tasks (elapsed time / estimated time). The bar is informational only — the task continues past 100%.

## Task Timing Fields

Tasks carry two distinct timestamp fields for tracking when work began:

| Field | Set when | Purpose |
|---|---|---|
| `createdAt` | Task created / enters queue | Queue entry time; used for FIFO ordering |
| `startedAt` | Task transitions to `starting` | Execution start time; used for duration calculation |

`durationSeconds` (in both dashboard and REST API responses) is calculated from `startedAt` when available, falling back to `createdAt` for backward compatibility with tasks that pre-date this field. This means the reported duration reflects actual execution time, excluding any time spent waiting in the queue.

If estimation fails (Docker error, non-numeric response), the system defaults to **600 seconds**.

## Git Authentication & Error Resilience

Tasks that use HTTPS repository URLs require a valid GitHub token for remote git operations (fetch, push, PR creation). The token can be configured via:
- `auth.githubToken` in the project config (recommended)
- `githubToken` field in the task request payload (for dynamic repos)

**Early warning:** If HTTPS repos are detected without a GitHub token, a warning is logged at the start of task execution. This helps identify misconfiguration before the task runs.

**Resilient post-execution flow:** After Claude finishes its work, the system performs several git operations (rebase, push, PR creation). These operations are designed to be resilient:
- **Rebase fetch failure:** If `git fetch origin` fails during the rebase step (e.g., invalid/missing token), the rebase is skipped for that repo and the system continues with push and PR creation. The commits are pushed as-is without rebasing.
- **Early branch push:** The initial push after branch creation (before Claude runs) is non-fatal — if it fails, execution continues.
- **Force push:** `--force-with-lease` is only used when rebase actually rewrote history. If rebase was skipped (e.g., due to fetch failure), a regular push is used instead.

## Known Limitations

- `timeoutSeconds` governs each individual `executor.run()` call. A single task execution may involve multiple `run()` calls (main run + commit fix + rebase conflict resolution). Each call has its own timer.
- The metadata generation calls (`generateTaskMetadata`) do not have a configurable timeout; they use a lightweight Haiku model and are expected to complete quickly.
- Duration estimates are rough heuristics from the Haiku model and may not be accurate for all tasks. They are intended as orientation only.
