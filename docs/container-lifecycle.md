# Container lifecycle and restart safety

## Overview

Each task execution spawns a dedicated Docker sandbox container. The container is created with `--rm` so it self-destructs when the Claude Code process exits normally. However, if the main implementer service is restarted while tasks are running, those containers may still be alive — Docker does not kill containers when the parent process that spawned them exits.

## Problem: double containers after restart

Without cleanup, the following scenario violates `maxConcurrentTasks`:

1. Service is running with 4 tasks active (4 sandbox containers).
2. Service is restarted (crash, deploy, etc.).
3. On startup, `resumeInterruptedTasks()` marks the 4 tasks as `running` again and spawns 4 **new** containers.
4. The 4 **old** containers from step 1 may still be running.
5. Total running containers = 8, exceeding the configured limit.

## Solution: `killStaleContainers()`

`killStaleContainers()` (exported from `src/executor.ts`) is called at the very beginning of `TaskManager.init()`, **before** workspace discovery and task resumption.

### Algorithm

1. Run `docker ps --filter name={INSTANCE_NAME}- --format {{.Names}}` to list all running containers belonging to this implementer instance.
2. If any are found, run `docker kill <container> ...` to forcibly stop them.
3. Errors (e.g., Docker not available) are caught and logged as warnings — startup proceeds regardless.

### Why `docker kill` instead of `docker stop`?

`docker stop` sends SIGTERM and waits up to 10 s before sending SIGKILL. Since the containers belong to **interrupted** tasks (the work will be re-done from scratch), there is no benefit in waiting for a graceful shutdown. `docker kill` terminates them immediately.

### Container name matching

Containers are filtered by the `INSTANCE_NAME` prefix (default: `implementer`). The Docker `name` filter uses substring matching, so `--filter name=implementer-` matches any container whose name contains `implementer-`. Since all sandbox containers follow the naming pattern `{INSTANCE_NAME}-{taskId}-{instanceId}-{counter}` (and similar for slug/meta/title containers), the filter correctly targets only this instance's containers.

When running multiple implementer instances on the same host, each instance must have a unique `INSTANCE_NAME` to ensure isolation.

## Sequence on startup

```
TaskManager.init()
  ├── killStaleContainers()           ← kills old containers first
  ├── pool.initFromDisk()             ← rediscovers workspace dirs
  ├── store.loadAll()                 ← loads persisted task states
  ├── recoverTask() × N               ← marks running→interrupted, re-queues retrying/starting
  ├── resumeInterruptedTasks()        ← starts fresh containers for interrupted tasks
  └── tryDequeue() × projects         ← starts queued tasks if capacity available
```

After `killStaleContainers()` completes, the number of running sandbox containers is guaranteed to be zero before any new containers are launched during recovery.

## Testing

Unit tests for `killStaleContainers()` are in `tests/kill-stale-containers.test.ts`. They mock `node:child_process.spawn` to verify:

- Correct `docker ps` filter arguments are used.
- `INSTANCE_NAME` env var is respected.
- `docker kill` is called with all found container names.
- Errors from both `docker ps` and `docker kill` are handled gracefully (no throw).
