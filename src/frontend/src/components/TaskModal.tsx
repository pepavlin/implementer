import { useState, useEffect } from "react";
import { api } from "../api/client";
import type { Task, TaskDetail } from "../types";

interface TaskModalProps {
    task: Task;
    onClose: () => void;
    onCancel: (taskId: string) => void;
    onRetry: (taskId: string) => void;
}

function formatDate(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleString();
}

function formatDuration(seconds: number | null): string {
    if (seconds === null) return "—";
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
}

const CANCELLABLE = new Set(["queued", "starting", "running", "retrying"]);
const RETRYABLE = new Set(["failed", "interrupted", "cancelled", "completed"]);

export function TaskModal({ task, onClose, onCancel, onRetry }: TaskModalProps) {
    const [detail, setDetail] = useState<TaskDetail | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        api.getTask(task.taskId)
            .then(setDetail)
            .catch(() => {/* use basic task data */})
            .finally(() => setLoading(false));
    }, [task.taskId]);

    const d = detail;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>{d?.title ?? task.title ?? task.taskId}</h2>
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>
                <div className="modal-body">
                    {loading ? (
                        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                            Loading details…
                        </div>
                    ) : (
                        <>
                            <div className="detail-grid">
                                <span className="detail-label">Task ID</span>
                                <span className="detail-value" style={{ fontFamily: "monospace", fontSize: 12 }}>
                                    {task.taskId}
                                </span>
                                <span className="detail-label">Project</span>
                                <span className="detail-value">{task.projectId}</span>
                                <span className="detail-label">Status</span>
                                <span className={`task-status-badge badge-${task.status}`}>
                                    {task.status}
                                </span>
                                {d?.branch && (
                                    <>
                                        <span className="detail-label">Branch</span>
                                        <span className="detail-value" style={{ fontFamily: "monospace", fontSize: 12 }}>
                                            {d.branch}
                                        </span>
                                    </>
                                )}
                                <span className="detail-label">Started</span>
                                <span className="detail-value">{formatDate(task.startedAt)}</span>
                                <span className="detail-label">Completed</span>
                                <span className="detail-value">{formatDate(task.completedAt)}</span>
                                <span className="detail-label">Duration</span>
                                <span className="detail-value">{formatDuration(task.durationSeconds)}</span>
                                {d?.attempt !== undefined && (
                                    <>
                                        <span className="detail-label">Attempt</span>
                                        <span className="detail-value">
                                            {d.attempt}{d.maxAttempts ? ` / ${d.maxAttempts}` : ""}
                                        </span>
                                    </>
                                )}
                                {d?.error && (
                                    <>
                                        <span className="detail-label">Error</span>
                                        <span className="detail-value" style={{ color: "var(--red)" }}>
                                            {d.error}
                                        </span>
                                    </>
                                )}
                            </div>

                            {task.pullRequests && task.pullRequests.length > 0 && (
                                <div style={{ marginBottom: 14 }}>
                                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
                                        Pull Requests
                                    </div>
                                    <div className="task-pr-links">
                                        {task.pullRequests.map((pr) => (
                                            <a
                                                key={pr.url}
                                                href={pr.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className={`pr-badge pr-${pr.state ?? "open"}`}
                                            >
                                                {pr.repo} — {pr.state ?? "open"}
                                            </a>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Prompt</div>
                            <div className="prompt-box">{task.prompt}</div>

                            {d?.output && (
                                <>
                                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
                                        Output
                                    </div>
                                    <div className="output-box">{d.output}</div>
                                </>
                            )}
                        </>
                    )}
                </div>
                <div className="modal-footer">
                    {CANCELLABLE.has(task.status) && (
                        <button
                            className="btn btn-danger"
                            onClick={() => { onCancel(task.taskId); onClose(); }}
                        >
                            Cancel Task
                        </button>
                    )}
                    {RETRYABLE.has(task.status) && (
                        <button
                            className="btn btn-ghost"
                            onClick={() => { onRetry(task.taskId); onClose(); }}
                        >
                            Retry Task
                        </button>
                    )}
                    <button className="btn btn-ghost" onClick={onClose}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
