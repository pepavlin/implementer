# Task Priority and Queue Pause

## Task Priority

Tasks can be assigned a **priority level** that controls the order in which they are dequeued and executed.

### Priority Levels

| Level | Weight | Description |
|-------|--------|-------------|
| `low` | 0 | Runs after all other priority levels |
| `normal` | 1 | Default priority for new tasks |
| `high` | 2 | Runs before normal and low tasks |
| `critical` | 3 | Runs before all other tasks |

### Sorting Rules

1. **Priority first** — higher weight tasks are started before lower weight tasks.
2. **FIFO within same priority** — when two tasks share the same priority, the one that was created earlier (`createdAt`) runs first.

### Setting Priority

**At creation time (API):**
```json
POST /task
{
  "prompt": "Implement the feature",
  "priority": "high"
}
```

**From the dashboard (New Task modal):** a priority dropdown is shown below the prompt field.

**After creation:** open the task detail modal and change the priority selector. The change takes effect immediately and influences the next dequeue cycle.

### Backward Compatibility

Tasks persisted before priority was introduced default to `normal` when loaded from disk.

---

## Global Queue Pause

The queue can be **paused globally** from the admin dashboard. While paused:

- No new tasks are dequeued or started.
- Tasks that are already **running or starting** continue to completion normally.
- Tasks in the queue remain queued until the queue is resumed.

### Usage

- Click the **"⏸ Pause"** button in the dashboard header to pause.
- A yellow banner appears at the top of the page confirming the paused state.
- Click **"▶ Resume"** (header button or banner button) to resume.
- On resume, `dequeueAvailableTasks()` is called immediately so eligible tasks start without waiting for the next poll interval.

### API

```
POST /dashboard/api/pause   → { "paused": true }
POST /dashboard/api/resume  → { "paused": false }
```

### Task Priority Update API

```
POST /dashboard/api/task/:taskId/priority
Content-Type: application/json

{ "priority": "critical" }

→ { "taskId": "...", "priority": "critical" }
```

---

## Implementation Details

### `PRIORITY_WEIGHT` constant (`src/types.ts`)

Maps priority strings to numeric weights used for sorting:

```ts
export const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
    low: 0,
    normal: 1,
    high: 2,
    critical: 3
};
```

### Queue sorting (`TaskManager.dequeueAvailableTasks`)

Before iterating the queue to start tasks, the queue is sorted:

```ts
const sortedQueue = [...this.queue].sort((aId, bId) => {
    const aPriority = PRIORITY_WEIGHT[a.data.priority ?? "normal"];
    const bPriority = PRIORITY_WEIGHT[b.data.priority ?? "normal"];
    if (bPriority !== aPriority) return bPriority - aPriority; // Higher priority first
    return new Date(a.data.createdAt).getTime() - new Date(b.data.createdAt).getTime(); // FIFO
});
```

### Initialization batching

During server startup, `dequeueAvailableTasks()` is suppressed while tasks are loaded from disk (via the `_initializing` flag). A single dequeue call runs after all tasks are loaded, ensuring priority sorting operates on the full queue rather than being triggered prematurely for each individual task.
