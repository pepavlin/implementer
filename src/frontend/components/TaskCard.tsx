import type { DashboardTask, PullRequest } from "../types/index.js";

function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function formatRelativeTime(iso: string): string {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

function PrBadge({ pr }: { pr: PullRequest }) {
    const stateClass =
        pr.state === "open"
            ? "pr-btn-open"
            : pr.state === "draft"
              ? "pr-btn-draft"
              : "";

    if (!stateClass) return null;

    return (
        <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className={`pr-btn ${stateClass}`}
            onClick={(e) => e.stopPropagation()}
        >
            {pr.state === "draft" ? "Draft" : "PR"}
        </a>
    );
}

function StatusBadge({ task }: { task: DashboardTask }) {
    const { status, durationSeconds, estimatedDurationSeconds } = task;

    const statusMap: Record<string, string> = {
        running: "b-running",
        starting: "b-starting",
        queued: "b-queued",
        retrying: "b-retrying",
        completed: "b-completed",
        failed: "b-failed",
        interrupted: "b-interrupted",
        cancelled: "b-cancelled"
    };

    const cls = statusMap[status] ?? "b-cancelled";

    const isActive = ["running", "starting"].includes(status);
    const isQueued = ["queued", "retrying"].includes(status);

    let progress: number | null = null;
    let isOverrun = false;
    if (isActive && estimatedDurationSeconds && durationSeconds !== null) {
        progress = Math.min(
            100,
            Math.round((durationSeconds / estimatedDurationSeconds) * 100)
        );
        isOverrun = durationSeconds > estimatedDurationSeconds;
    }

    return (
        <div>
            <span className={`badge ${cls}`}>
                {isActive && <span className="badge-spin" />}
                {isQueued && (
                    <span className="badge-dots">
                        <span />
                        <span />
                        <span />
                    </span>
                )}
                {status}
            </span>

            {isActive && (
                <div className="task-progress">
                    <div className="progress-track">
                        <div
                            className={`progress-fill${isOverrun ? " overrun" : ""}`}
                            style={{ width: `${progress ?? 0}%` }}
                        />
                    </div>
                    {progress !== null && (
                        <span className="progress-pct">{progress}%</span>
                    )}
                    {estimatedDurationSeconds && (
                        <span className="progress-est">
                            est {formatDuration(estimatedDurationSeconds)}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}

interface TaskCardProps {
    task: DashboardTask;
    isNew: boolean;
    onClick: () => void;
    selectionMode: boolean;
    selected: boolean;
    onToggleSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function TaskCard({
    task,
    isNew,
    onClick,
    selectionMode,
    selected,
    onToggleSelect
}: TaskCardProps) {
    const openPrs =
        task.pullRequests?.filter((pr) => pr.state === "open" || pr.state === "draft") ??
        [];
    const hasOpenPr = task.pullRequests?.some((pr) => pr.state === "open");

    let rowClass = `tr-${task.status}`;
    if (task.status === "completed") {
        rowClass = isNew ? "tr-completed-new" : "tr-completed-old";
    }
    if (hasOpenPr) rowClass += " open-pr-row";
    if (selected) rowClass += " tr-sel";

    return (
        <tr
            className={`clickable ${rowClass}`}
            onClick={selectionMode ? undefined : onClick}
        >
            <td className="td-cb">
                <input
                    type="checkbox"
                    className="task-cb"
                    checked={selected}
                    onChange={onToggleSelect}
                    onClick={(e) => e.stopPropagation()}
                />
            </td>
            <td className="td-taskid">
                <span className="mono">{task.taskId.slice(0, 8)}</span>
            </td>
            <td>
                <div>
                    <span className="proj-tag">{task.projectId}</span>{" "}
                    <span className="ttitle">{task.title ?? ""}</span>
                </div>
                <div className="tprompt">
                    {task.prompt.length > 120
                        ? task.prompt.slice(0, 120) + "…"
                        : task.prompt}
                </div>
            </td>
            <td>
                <StatusBadge task={task} />
            </td>
            <td className="td-pr">
                {openPrs.map((pr, i) => (
                    <PrBadge key={i} pr={pr} />
                ))}
            </td>
            <td className="td-dur">
                {task.durationSeconds !== null
                    ? formatDuration(task.durationSeconds)
                    : "—"}
            </td>
            <td className="td-started">
                {formatRelativeTime(task.startedAt)}
            </td>
        </tr>
    );
}
