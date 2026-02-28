import type { Task } from "../types";

interface TaskCardProps {
    task: Task;
    selected: boolean;
    selectionMode: boolean;
    onSelect: (id: string, checked: boolean) => void;
    onClick: (task: Task) => void;
    onCancel: (taskId: string) => void;
    onRetry: (taskId: string) => void;
}

function formatDuration(seconds: number | null): string {
    if (seconds === null) return "";
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
}

function formatDate(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

const ACTIVE_STATUSES = new Set(["queued", "starting", "running", "retrying"]);
const CANCELLABLE = new Set(["queued", "starting", "running", "retrying"]);
const RETRYABLE = new Set(["failed", "interrupted", "cancelled", "completed"]);

export function TaskCard({
    task,
    selected,
    selectionMode,
    onSelect,
    onClick,
    onCancel,
    onRetry
}: TaskCardProps) {
    const isActive = ACTIVE_STATUSES.has(task.status);
    const durationPct =
        isActive &&
        task.estimatedDurationSeconds &&
        task.durationSeconds !== null
            ? Math.min(
                  100,
                  Math.round(
                      (task.durationSeconds / task.estimatedDurationSeconds) *
                          100
                  )
              )
            : null;

    return (
        <div
            className={`task-card status-${task.status} ${selected ? "selected" : ""}`}
            onClick={() => onClick(task)}
        >
            {selectionMode && (
                <input
                    type="checkbox"
                    className="task-checkbox"
                    checked={selected}
                    onChange={(e) => {
                        e.stopPropagation();
                        onSelect(task.taskId, e.target.checked);
                    }}
                    onClick={(e) => e.stopPropagation()}
                />
            )}
            <div className="task-status-dot" />
            <div className="task-body">
                <div className="task-title">
                    {task.title ?? task.prompt.slice(0, 120)}
                </div>
                <div className="task-meta">
                    <span className="task-project">{task.projectId}</span>
                    <span
                        className={`task-status-badge badge-${task.status}`}
                    >
                        {task.status}
                    </span>
                    <span>{formatDate(task.startedAt)}</span>
                    {task.durationSeconds !== null && (
                        <span>{formatDuration(task.durationSeconds)}</span>
                    )}
                    {durationPct !== null && (
                        <div className="duration-progress">
                            <div className="duration-bar">
                                <div
                                    className="duration-bar-fill"
                                    style={{ width: `${durationPct}%` }}
                                />
                            </div>
                            <span>{durationPct}%</span>
                        </div>
                    )}
                    {task.pullRequests && task.pullRequests.length > 0 && (
                        <div className="task-pr-links">
                            {task.pullRequests.map((pr) => (
                                <a
                                    key={pr.url}
                                    href={pr.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className={`pr-badge pr-${pr.state ?? "open"}`}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    PR
                                </a>
                            ))}
                        </div>
                    )}
                </div>
            </div>
            <div className="task-actions" onClick={(e) => e.stopPropagation()}>
                {CANCELLABLE.has(task.status) && (
                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => onCancel(task.taskId)}
                        title="Cancel task"
                    >
                        ✕
                    </button>
                )}
                {RETRYABLE.has(task.status) && (
                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => onRetry(task.taskId)}
                        title="Retry task"
                    >
                        ↺
                    </button>
                )}
            </div>
        </div>
    );
}
