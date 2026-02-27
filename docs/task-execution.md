# Task Execution & Reliability

## Overview

Tasks are executed by spawning a Docker container that runs Claude Code CLI against an isolated workspace. The `Executor` class manages this lifecycle.

## Execution Timeout

**Problem addressed:** Without a timeout, a task that hangs (e.g., Claude Code waiting for a tool response that never arrives, an infinite loop, or a network stall) would remain in `running` status indefinitely. The workspace slot would be occupied forever, and no retry or failure would ever trigger.

**Solution:** The `timeoutSeconds` field in `claudeCode` config sets a wall-clock limit per executor run.

```yaml
claudeCode:
  timeoutSeconds: 3600  # Kill after 1 hour
```

When the timeout fires:
1. A `[TIMEOUT]` message is appended to the task output so it's visible in logs/dashboard.
2. `executor.kill()` is called, which:
   - Sends `SIGTERM` to the `docker run` child process.
   - Calls `docker kill <containerName>` directly for reliability (handles cases where signal forwarding fails).
3. The container exits with a non-zero code (typically 137).
4. The task is marked `failed` with the error message.
5. If `errorRetry` is configured, the task is automatically retried.

**Recommended value:** `3600` (1 hour). Adjust based on your typical task durations.

## Kill Reliability

The `kill()` method was improved to always kill the Docker container by name in addition to sending SIGTERM to the Node child process. This ensures the container stops even if:
- The `docker run` process is slow to forward signals.
- The container process ignores SIGTERM.

## Retry on Timeout

Configure `errorRetry` alongside `timeoutSeconds` to automatically retry timed-out tasks:

```yaml
claudeCode:
  timeoutSeconds: 3600
errorRetry:
  maxAttempts: 3       # 1 original + 2 retries
  delaySeconds: 60     # Wait 1 minute before retrying
```

A timed-out task gets exit code 137 (non-zero), which triggers the retry logic exactly like any other failure.

## Task State Machine

```
starting → queued → running → completed
                  ↓          ↓
               retrying ← failed (if retries configured)
                  ↓
               running → ...
```

States:
- `starting` – metadata (branch slug, title) being generated
- `queued` – waiting for a free workspace slot
- `running` – Docker container active
- `retrying` – waiting for `delaySeconds` before next attempt
- `completed` – Claude exited 0, PR created
- `failed` – terminal failure (all retries exhausted or no retry configured)
- `interrupted` – server restarted while task was running; will be resumed on next boot
- `cancelled` – manually cancelled via API

## Crash Recovery

On server restart:
- `running` → `interrupted`: task resumes immediately on its existing branch; first post-restart failure skips the normal retry delay.
- `retrying` → `queued`: dropped delay, retried as soon as capacity is available.
- `queued` → `queued`: stays in queue, re-enqueued on startup.

## Known Limitations

- `timeoutSeconds` governs each individual `executor.run()` call. A single task execution may involve multiple `run()` calls (main run + commit fix + rebase conflict resolution). Each call has its own timer.
- The metadata generation calls (`generateTaskMetadata`) do not have a configurable timeout; they use a lightweight Haiku model and are expected to complete quickly.
