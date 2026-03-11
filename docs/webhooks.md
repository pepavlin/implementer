# GitHub Webhooks

The implementer supports receiving GitHub webhook events for real-time PR and pipeline status updates, eliminating the need to wait for the default 5-minute polling interval.

## Architecture

Two webhook modes are available:

### Unified webhook (recommended)

All repositories share a **single webhook URL**. The handler automatically determines which project an event belongs to based on the repository name in the payload.

```
GitHub Repository A ─┐
GitHub Repository B ─┤   POST /webhook/github
GitHub Repository C ─┼──────────────────────────►  Webhook Handler
                     │                                   │
                     │                                   ├─ Verify HMAC SHA-256 (server.webhookSecret)
                     │                                   ├─ Extract repo name from payload
                     │                                   ├─ Look up matching project
                     │                                   ├─ Filter: is event relevant?
                     │                                   └─ Trigger PrPoller.pollProject()
                     │                                           │
                     │                                           ▼
                     │                                   PR state + pipeline checks
                     │                                   updated in real-time
```

### Per-project webhook (legacy)

Each project has its own webhook URL with its own secret. Useful when different projects need different webhook secrets.

```
GitHub Repository
    │
    ├─ pull_request event ──────┐
    ├─ check_run event ─────────┤
    ├─ check_suite event ───────┤   POST /webhook/github/:projectId
    └─ workflow_run event ──────┼──────────────────────────────────►  Webhook Handler
                                │                                        │
                                │                                        ├─ Verify HMAC SHA-256 (project webhookSecret)
                                │                                        ├─ Filter: is event relevant?
                                │                                        ├─ Filter: does repo belong to project?
                                │                                        └─ Trigger PrPoller.pollProject()
```

## Configuration

### Unified webhook (recommended)

Add `webhookSecret` to the `server` section in `config.yaml`:

```yaml
server:
    webhookSecret: ${GITHUB_WEBHOOK_SECRET}

projects:
    project-a:
        repositories:
            - name: repo-a
              url: https://github.com/org/repo-a.git
    project-b:
        repositories:
            - name: repo-b
              url: https://github.com/org/repo-b.git
```

All GitHub repositories point to the same URL (`POST /webhook/github`) and use the same secret. The handler routes events to the correct project by matching the `repository.full_name` from the payload against each project's configured repository URLs.

### Per-project webhook

Add `webhookSecret` to individual projects in `config.yaml`:

```yaml
projects:
    my-project:
        webhookSecret: ${GITHUB_WEBHOOK_SECRET}
        # ... other project config
```

The secret must match the one configured in the GitHub repository webhook settings.

## Endpoints

### `POST /webhook/github` (unified)

Single endpoint for all projects. Requires `server.webhookSecret` to be configured.

The response includes the auto-detected `projectId`:

```json
{
    "accepted": true,
    "projectId": "my-project",
    "reason": "pull_request opened"
}
```

When no project matches the repository:

```json
{
    "accepted": false,
    "reason": "No project configured for repository org/unknown-repo"
}
```

#### Error responses

| Status | Condition |
|--------|-----------|
| 400 | Missing body, missing `X-GitHub-Event` header, or `server.webhookSecret` not configured |
| 401 | Invalid signature |

### `POST /webhook/github/:projectId` (per-project)

Project-specific endpoint. Requires the project's `webhookSecret` to be configured.

```json
{
    "accepted": true,
    "reason": "pull_request opened"
}
```

#### Error responses

| Status | Condition |
|--------|-----------|
| 400 | Missing body, missing `X-GitHub-Event` header, or project `webhookSecret` not configured |
| 401 | Invalid signature |
| 404 | Project not found |

### Common headers

| Header | Required | Description |
|--------|----------|-------------|
| `X-GitHub-Event` | Yes | Event type (e.g. `pull_request`, `check_run`) |
| `X-Hub-Signature-256` | Yes | HMAC SHA-256 signature for payload verification |
| `X-GitHub-Delivery` | No | Unique delivery ID (logged for debugging) |
| `Content-Type` | Yes | Must be `application/json` |

### Authentication

Neither endpoint uses Bearer token authentication. Both verify requests using HMAC SHA-256 signature verification — the unified endpoint uses `server.webhookSecret`, while per-project endpoints use the project's `webhookSecret`.

## Supported Events

### `pull_request`

Triggers poll on these actions:
- `opened` — new PR created
- `closed` — PR closed or merged
- `reopened` — previously closed PR reopened
- `synchronize` — new commits pushed to PR
- `ready_for_review` — draft PR marked ready
- `converted_to_draft` — PR converted to draft

Ignored actions: `labeled`, `unlabeled`, `assigned`, `unassigned`, `review_requested`, `edited`, `locked`, etc.

### `check_run`

Triggers poll on:
- `completed` — a CI check run finished

Ignored: `created`, `rerequested`

### `check_suite`

Triggers poll on:
- `completed` — all check runs in the suite finished

Ignored: `requested`, `rerequested`

### `workflow_run`

Triggers poll on:
- `completed` — a GitHub Actions workflow finished

Ignored: `requested`, `in_progress`

## Repository Matching

The webhook handler matches the `repository.full_name` (e.g. `org/repo-name`) from the payload against each project's configured repository URLs.

Matching is case-insensitive and handles both URL formats:
- `https://github.com/org/repo.git` (configured)
- `https://github.com/org/repo` (in webhook payload)
- `git@github.com:org/repo.git` (SSH-style)

For the unified endpoint, this matching determines which project receives the event. For per-project endpoints, it validates that the event belongs to the specified project.

## Deduplication

If multiple webhook events arrive simultaneously for the same project, only one poll executes — subsequent calls are skipped while the first is in progress.

## Fallback

The regular 5-minute background polling continues regardless of webhook configuration. Webhooks provide faster response times but the polling interval ensures nothing is missed if a webhook delivery fails.

## GitHub Webhook Setup

### Unified webhook (recommended)

1. Go to your GitHub repository → Settings → Webhooks → Add webhook
2. Set **Payload URL** to: `https://your-host/webhook/github`
3. Set **Content type** to: `application/json`
4. Set **Secret** to: the same value as `server.webhookSecret` in your config
5. Select **"Let me select individual events"** and check:
   - Pull requests
   - Check runs
   - Check suites
   - Workflow runs
6. Save
7. **Repeat for each repository** — all use the same URL and secret

### Per-project webhook

1. Go to your GitHub repository → Settings → Webhooks → Add webhook
2. Set **Payload URL** to: `https://your-host/webhook/github/<projectId>`
3. Set **Content type** to: `application/json`
4. Set **Secret** to: the same value as the project's `webhookSecret` in your config
5. Select the same events as above
6. Save

## Source Files

- `src/webhook-handler.ts` — Signature verification, event filtering, payload extraction
- `src/server.ts` — Webhook route registration (unified + per-project)
- `src/config/config.ts` — `findProjectByRepo()` for auto-routing
- `src/pr-poller.ts` — `pollProject()` method for targeted polling
- `src/task-manager/task-manager.ts` — `triggerProjectPoll()` bridge method
