# GitHub Webhooks

The implementer supports receiving GitHub webhook events for real-time PR and pipeline status updates, eliminating the need to wait for the default 5-minute polling interval.

## Architecture

```
GitHub Repository
    │
    ├─ pull_request event ──────┐
    ├─ check_run event ─────────┤
    ├─ check_suite event ───────┤   POST /webhook/github/:projectId
    └─ workflow_run event ──────┼──────────────────────────────────►  Webhook Handler
                                │                                        │
                                │                                        ├─ Verify HMAC SHA-256 signature
                                │                                        ├─ Filter: is event relevant?
                                │                                        ├─ Filter: does repo belong to project?
                                │                                        └─ Trigger immediate PrPoller.pollProject()
                                │                                                │
                                │                                                ▼
                                │                                        PR state + pipeline checks
                                │                                        updated in real-time
```

## Configuration

Add `webhookSecret` to any project in `config.yaml`:

```yaml
projects:
    my-project:
        webhookSecret: ${GITHUB_WEBHOOK_SECRET}
        # ... other project config
```

The secret must match the one configured in the GitHub repository webhook settings.

## Endpoint

```
POST /webhook/github/:projectId
```

### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `X-GitHub-Event` | Yes | Event type (e.g. `pull_request`, `check_run`) |
| `X-Hub-Signature-256` | Yes | HMAC SHA-256 signature for payload verification |
| `X-GitHub-Delivery` | No | Unique delivery ID (logged for debugging) |
| `Content-Type` | Yes | Must be `application/json` |

### Authentication

The endpoint does **not** use Bearer token authentication. Instead, it verifies the request using HMAC SHA-256 signature verification with the project's `webhookSecret`. This is the standard GitHub webhook authentication mechanism.

### Response

Always returns HTTP 200 with a JSON body:

```json
{
    "accepted": true,
    "reason": "pull_request opened"
}
```

Or for ignored events:

```json
{
    "accepted": false,
    "reason": "pull_request action \"labeled\" is not a relevant state change"
}
```

### Error responses

| Status | Condition |
|--------|-----------|
| 400 | Missing body, missing `X-GitHub-Event` header, or `webhookSecret` not configured |
| 401 | Invalid signature |
| 404 | Project not found |

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

## Repository Validation

The webhook handler verifies that the repository in the event payload matches one of the project's configured repositories. Events from unrelated repositories are acknowledged (200) but not processed.

Matching is case-insensitive and handles both URL formats:
- `https://github.com/org/repo.git` (configured)
- `https://github.com/org/repo` (in webhook payload)

## Deduplication

If multiple webhook events arrive simultaneously for the same project, only one poll executes — subsequent calls are skipped while the first is in progress.

## Fallback

The regular 5-minute background polling continues regardless of webhook configuration. Webhooks provide faster response times but the polling interval ensures nothing is missed if a webhook delivery fails.

## GitHub Webhook Setup

1. Go to your GitHub repository → Settings → Webhooks → Add webhook
2. Set **Payload URL** to: `https://your-host/webhook/github/<projectId>`
3. Set **Content type** to: `application/json`
4. Set **Secret** to: the same value as `webhookSecret` in your config
5. Select **"Let me select individual events"** and check:
   - Pull requests
   - Check runs
   - Check suites
   - Workflow runs
6. Save

## Source Files

- `src/webhook-handler.ts` — Signature verification, event filtering logic
- `src/server.ts` — Webhook route registration
- `src/pr-poller.ts` — `pollProject()` method for targeted polling
- `src/task-manager/task-manager.ts` — `triggerProjectPoll()` bridge method
