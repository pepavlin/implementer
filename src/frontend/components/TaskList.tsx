import { useState, useCallback } from "react";
import { ListChecks } from "lucide-react";
import { TaskCard } from "./TaskCard.js";
import { bulkCancel, bulkRetry } from "../api/client.js";
import type { DashboardTask, StatusFilter } from "../types/index.js";

const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
    { label: "All", value: "all" },
    { label: "Running", value: "running" },
    { label: "Queued", value: "queued" },
    { label: "Retrying", value: "retrying" },
    { label: "Completed", value: "completed" },
    { label: "Failed", value: "failed" },
    { label: "Interrupted", value: "interrupted" }
];

// Tasks completed within last 5 minutes are "new"
const NEW_THRESHOLD_MS = 5 * 60 * 1000;

interface TaskListProps {
    tasks: DashboardTask[];
    selectedProject: string | null;
    statusFilter: StatusFilter;
    onStatusFilterChange: (filter: StatusFilter) => void;
    onTaskClick: (taskId: string) => void;
    onNewTask: () => void;
}

export function TaskList({
    tasks,
    selectedProject,
    statusFilter,
    onStatusFilterChange,
    onTaskClick,
    onNewTask
}: TaskListProps) {
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [bulkLoading, setBulkLoading] = useState(false);

    const filteredTasks = tasks.filter((t) => {
        if (selectedProject && t.projectId !== selectedProject) return false;
        if (statusFilter === "all") return true;
        if (statusFilter === "running")
            return t.status === "running" || t.status === "starting";
        if (statusFilter === "queued")
            return t.status === "queued" || t.status === "retrying";
        return t.status === statusFilter;
    });

    const exitSelectionMode = useCallback(() => {
        setSelectionMode(false);
        setSelectedIds(new Set());
    }, []);

    const toggleSelectionMode = useCallback(() => {
        setSelectionMode((prev) => {
            if (prev) {
                setSelectedIds(new Set());
                return false;
            }
            return true;
        });
    }, []);

    const handleToggleSelect = useCallback(
        (taskId: string, checked: boolean) => {
            setSelectedIds((prev) => {
                const next = new Set(prev);
                if (checked) next.add(taskId);
                else next.delete(taskId);
                return next;
            });
        },
        []
    );

    const handleBulkRetry = useCallback(async () => {
        const ids = [...selectedIds];
        if (ids.length === 0) return;
        setBulkLoading(true);
        try {
            await bulkRetry(ids);
            exitSelectionMode();
        } catch (e) {
            console.error("Bulk retry failed:", e);
        } finally {
            setBulkLoading(false);
        }
    }, [selectedIds, exitSelectionMode]);

    const handleBulkCancel = useCallback(async () => {
        const ids = [...selectedIds];
        if (ids.length === 0) return;
        setBulkLoading(true);
        try {
            await bulkCancel(ids);
            exitSelectionMode();
        } catch (e) {
            console.error("Bulk cancel failed:", e);
        } finally {
            setBulkLoading(false);
        }
    }, [selectedIds, exitSelectionMode]);

    const now = Date.now();

    return (
        <div>
            <div className="tasks-header">
                <div className="section-title">
                    Tasks
                    {selectedProject && ` — ${selectedProject}`}
                </div>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <button
                        className={`btn-sel-mode${selectionMode ? " active" : ""}`}
                        onClick={toggleSelectionMode}
                        title="Toggle selection mode"
                    >
                        <ListChecks size={14} style={{ verticalAlign: "middle" }} />
                    </button>
                    <button className="btn-new" onClick={onNewTask}>
                        + New Task
                    </button>
                </div>
            </div>

            <div className="filters">
                {STATUS_FILTERS.map(({ label, value }) => (
                    <button
                        key={value}
                        className={`filter-btn${statusFilter === value ? " active" : ""}`}
                        onClick={() => onStatusFilterChange(value)}
                    >
                        {label}
                    </button>
                ))}
            </div>

            <div className="table-wrap">
                <table className={selectionMode ? "selection-mode" : ""}>
                    <thead>
                        <tr>
                            <th className="th-cb" />
                            <th className="th-taskid">ID</th>
                            <th>Task</th>
                            <th>Status</th>
                            <th className="th-pr">PR</th>
                            <th className="th-dur">Duration</th>
                            <th className="th-started">Started</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filteredTasks.length === 0 ? (
                            <tr>
                                <td colSpan={7} className="empty">
                                    No tasks
                                    {selectedProject
                                        ? ` for ${selectedProject}`
                                        : ""}
                                    {statusFilter !== "all"
                                        ? ` with status ${statusFilter}`
                                        : ""}
                                </td>
                            </tr>
                        ) : (
                            filteredTasks.map((task) => {
                                const isNew =
                                    task.status === "completed" &&
                                    task.completedAt !== null &&
                                    now - new Date(task.completedAt).getTime() <
                                        NEW_THRESHOLD_MS;
                                return (
                                    <TaskCard
                                        key={task.taskId}
                                        task={task}
                                        isNew={isNew}
                                        onClick={() => onTaskClick(task.taskId)}
                                        selectionMode={selectionMode}
                                        selected={selectedIds.has(task.taskId)}
                                        onToggleSelect={(e) =>
                                            handleToggleSelect(
                                                task.taskId,
                                                e.target.checked
                                            )
                                        }
                                    />
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>

            {selectionMode && selectedIds.size > 0 && (
                <div className="bulk-bar">
                    <span className="bulk-count">
                        {selectedIds.size} selected
                    </span>
                    <button
                        className="btn-bulk-retry"
                        onClick={handleBulkRetry}
                        disabled={bulkLoading}
                    >
                        Retry selected
                    </button>
                    <button
                        className="btn-bulk-cancel"
                        onClick={handleBulkCancel}
                        disabled={bulkLoading}
                    >
                        Cancel selected
                    </button>
                    <button
                        className="btn-bulk-clear"
                        onClick={exitSelectionMode}
                    >
                        Clear
                    </button>
                </div>
            )}
        </div>
    );
}
