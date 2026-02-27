# Pull Request State Tracking

Implementer automatically tracks the state of pull requests created by tasks and displays that state in the dashboard.

## PR States

Each pull request stores one of four states:

| State | Meaning | Badge color |
|-------|---------|-------------|
| `open` | PR is open and ready for review | Green |
| `draft` | PR is open but marked as a draft | Gray |
| `merged` | PR has been merged | Purple |
| `closed` | PR was closed without merging | Red |

## Initial State Assignment

When a pull request is created by `git-manager.ts`:

- A **successful** task creates a **ready** (non-draft) PR → initial state: `open`
- A **failed or timed-out** task with partial commits creates a **draft** PR → initial state: `draft`
- If the PR already existed (retrieved rather than created), the state is read from GitHub at creation time

## Background Polling

The `PrPoller` class (`src/pr-poller.ts`) runs a background timer that periodically checks all non-terminal pull requests:

- **Interval**: every 5 minutes (configurable via constructor)
- **What is polled**: PRs whose state is `open`, `draft`, or `undefined` (newly created, not yet checked)
- **Skipped**: PRs in `merged` or `closed` state — these are terminal and never change
- **Auth**: uses each project's `githubToken` from the config; inherits `GITHUB_TOKEN` env var if not set
- **Command**: `gh pr view <url> --json state,isDraft`

The poller is started automatically during `TaskManager.init()` and uses the `TaskManager` as a `TaskAccessor` to read tasks and write updated PR states.

### Error Handling

- Failed `gh` queries are logged but do not crash the poller
- Errors from individual PRs are collected and logged after all concurrent checks complete
- The poller continues operating normally after transient errors

## Dashboard Integration

PR state is surfaced in multiple places in the dashboard:

### Stats Bar
An **Open PRs** counter shows the total number of `open` or `draft` pull requests across all tasks. Clicking the card filters the task list to show only tasks with open PRs. The card glows when there are open PRs.

### Task Table
Tasks with at least one `open` or `draft` PR:
- Show a colored left-border highlight (green)
- Display compact PR state badges (e.g. `● Open`, `○ Draft`) next to the task title

### Task Detail Modal
Each pull request link shows:
- A state badge (`● Open`, `○ Draft`, `✕ Merged`, `✕ Closed`)
- The PR URL as a clickable link
- The timestamp of the last state check

### Filter Button
A dedicated **Open PRs** filter button in the task filter bar shows only tasks that have at least one `open` or `draft` pull request.

## Data Flow

```
GitHub                PrPoller (every 5 min)
  │                        │
  │   gh pr view <url>     │
  │◄───────────────────────│
  │                        │
  │   { state, isDraft }   │
  │───────────────────────►│
  │                        │
  │              TaskManager.updatePrState()
  │                        │
  │              TaskStore.save() (to disk)
  │                        │
  │              Dashboard SSE push (every 3s)
  │                        │
  │                      Browser renders updated state
```

## Architecture

| Component | File | Responsibility |
|-----------|------|----------------|
| `PullRequest` type | `src/types.ts` | Holds `state` and `lastCheckedAt` fields |
| `PrPoller` | `src/pr-poller.ts` | Background polling, state normalization |
| `TaskAccessor` interface | `src/pr-poller.ts` | Decouples poller from TaskManager for testing |
| `TaskManager.updatePrState()` | `src/task-manager/task-manager.ts` | Writes new state to task and persists to disk |
| `GitManager.createPullRequestAll()` | `src/git-manager.ts` | Sets initial state on PR creation |
| `buildDashboardData()` | `src/dashboard.ts` | Includes PR state + `openPrs` count in SSE data |
