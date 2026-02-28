import { useState, useCallback } from "react";
import type { DashboardData, Task } from "../types";
import { StatsCards } from "./StatsCards";
import { TaskCard } from "./TaskCard";
import { TaskModal } from "./TaskModal";
import { VoiceMode } from "./VoiceMode";
import { NewTaskForm } from "./NewTaskForm";
import { api } from "../api/client";

interface DashboardPageProps {
    data: DashboardData;
    onRefresh: () => void;
    onLogout: () => void;
}

type StatusFilter = "all" | "active" | "failed" | "completed" | "cancelled";

const ACTIVE_STATUSES = new Set(["queued", "starting", "running", "retrying"]);
const FAILED_STATUSES = new Set(["failed", "interrupted"]);

export function DashboardPage({ data, onRefresh, onLogout }: DashboardPageProps) {
    const [selectedTask, setSelectedTask] = useState<Task | null>(null);
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
    const [projectFilter, setProjectFilter] = useState<string | null>(null);
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [voiceMode, setVoiceMode] = useState(false);
    const [theme, setTheme] = useState<"dark" | "light">(
        document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"
    );

    const projects = Object.keys(data.projects);

    // Filter tasks
    const filteredTasks = data.tasks.filter((t) => {
        if (projectFilter && t.projectId !== projectFilter) return false;
        if (statusFilter === "active") return ACTIVE_STATUSES.has(t.status);
        if (statusFilter === "failed") return FAILED_STATUSES.has(t.status);
        if (statusFilter === "completed") return t.status === "completed";
        if (statusFilter === "cancelled") return t.status === "cancelled";
        return true;
    });

    function toggleTheme() {
        const html = document.documentElement;
        const isLight = html.getAttribute("data-theme") === "light";
        if (isLight) {
            html.removeAttribute("data-theme");
            try { localStorage.removeItem("impl-theme"); } catch { /* ignore */ }
            setTheme("dark");
        } else {
            html.setAttribute("data-theme", "light");
            try { localStorage.setItem("impl-theme", "light"); } catch { /* ignore */ }
            setTheme("light");
        }
    }

    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            void document.documentElement.requestFullscreen();
        } else {
            void document.exitFullscreen();
        }
    }

    function handleSelect(id: string, checked: boolean) {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
        });
    }

    function toggleSelectionMode() {
        setSelectionMode((v) => !v);
        setSelectedIds(new Set());
        if (voiceMode) setVoiceMode(false);
    }

    function selectAll() {
        setSelectedIds(new Set(filteredTasks.map((t) => t.taskId)));
    }

    async function bulkCancel() {
        if (!selectedIds.size) return;
        await api.bulkCancel([...selectedIds]);
        setSelectedIds(new Set());
        onRefresh();
    }

    async function bulkRetry() {
        if (!selectedIds.size) return;
        await api.bulkRetry([...selectedIds]);
        setSelectedIds(new Set());
        onRefresh();
    }

    async function retryFailed() {
        await api.retryFailed();
        onRefresh();
    }

    const handleCancel = useCallback(async (taskId: string) => {
        await api.cancelTask(taskId);
        onRefresh();
    }, [onRefresh]);

    const handleRetry = useCallback(async (taskId: string) => {
        await api.retryTask(taskId);
        onRefresh();
    }, [onRefresh]);

    const failedCount = data.stats.failed + data.stats.interrupted;

    return (
        <div className="app-layout">
            {/* Header */}
            <header className="header">
                <span className="header-title">Implementer</span>
                <div className="header-spacer" />
                <div className="header-actions">
                    {failedCount > 0 && (
                        <button
                            className="btn btn-danger btn-sm"
                            onClick={() => void retryFailed()}
                            title="Retry all failed tasks"
                        >
                            Retry failed ({failedCount})
                        </button>
                    )}
                    <button
                        className={`icon-btn ${voiceMode ? "active" : ""}`}
                        onClick={() => { setVoiceMode((v) => !v); if (selectionMode) setSelectionMode(false); }}
                        title="Voice mode"
                    >
                        🎙
                    </button>
                    <button
                        className={`icon-btn ${selectionMode ? "active" : ""}`}
                        onClick={toggleSelectionMode}
                        title="Selection mode"
                    >
                        ☑
                    </button>
                    <button className="icon-btn" onClick={toggleTheme} title="Toggle theme">
                        {theme === "dark" ? "☀" : "☾"}
                    </button>
                    <button className="icon-btn" onClick={toggleFullscreen} title="Fullscreen">
                        ⛶
                    </button>
                    <button className="icon-btn" onClick={onRefresh} title="Refresh">
                        ↻
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={onLogout}>
                        Logout
                    </button>
                </div>
            </header>

            <div className="main-content">
                {/* Stats */}
                <StatsCards stats={data.stats} />

                {/* Voice Mode Panel */}
                {voiceMode && (
                    <VoiceMode projects={projects} onTaskCreated={onRefresh} />
                )}

                {/* New Task Form */}
                {!voiceMode && projects.length > 0 && (
                    <NewTaskForm projects={projects} onCreated={onRefresh} />
                )}

                {/* Project Filter */}
                {projects.length > 1 && (
                    <div className="project-section">
                        <span className="project-label">Project:</span>
                        <button
                            className={`project-pill ${projectFilter === null ? "active" : ""}`}
                            onClick={() => setProjectFilter(null)}
                        >
                            All
                        </button>
                        {projects.map((p) => (
                            <button
                                key={p}
                                className={`project-pill ${projectFilter === p ? "active" : ""}`}
                                onClick={() => setProjectFilter(projectFilter === p ? null : p)}
                            >
                                {p}
                            </button>
                        ))}
                    </div>
                )}

                {/* Task List */}
                <div className="task-list-container">
                    <div className="task-list-header">
                        {/* Status filter tabs */}
                        {(["all", "active", "failed", "completed", "cancelled"] as StatusFilter[]).map((f) => (
                            <button
                                key={f}
                                className={`btn btn-ghost btn-sm ${statusFilter === f ? "active" : ""}`}
                                style={statusFilter === f ? { color: "var(--accent)", borderColor: "var(--accent)" } : {}}
                                onClick={() => setStatusFilter(f)}
                            >
                                {f.charAt(0).toUpperCase() + f.slice(1)}
                            </button>
                        ))}
                        <span className="task-count">{filteredTasks.length} tasks</span>
                        <div className="task-list-actions">
                            {/* empty for spacing */}
                        </div>
                    </div>

                    {/* Selection toolbar */}
                    {selectionMode && (
                        <div className="selection-toolbar">
                            <span className="selection-count">{selectedIds.size} selected</span>
                            <button className="btn btn-ghost btn-sm" onClick={selectAll}>
                                Select all
                            </button>
                            <div className="selection-actions">
                                <button
                                    className="btn btn-ghost btn-sm"
                                    disabled={!selectedIds.size}
                                    onClick={() => void bulkRetry()}
                                >
                                    Retry selected
                                </button>
                                <button
                                    className="btn btn-danger btn-sm"
                                    disabled={!selectedIds.size}
                                    onClick={() => void bulkCancel()}
                                >
                                    Cancel selected
                                </button>
                            </div>
                        </div>
                    )}

                    {filteredTasks.length === 0 ? (
                        <div className="task-list-empty">No tasks found</div>
                    ) : (
                        filteredTasks.map((task) => (
                            <TaskCard
                                key={task.taskId}
                                task={task}
                                selected={selectedIds.has(task.taskId)}
                                selectionMode={selectionMode}
                                onSelect={handleSelect}
                                onClick={setSelectedTask}
                                onCancel={(id) => void handleCancel(id)}
                                onRetry={(id) => void handleRetry(id)}
                            />
                        ))
                    )}
                </div>
            </div>

            {selectedTask && (
                <TaskModal
                    task={selectedTask}
                    onClose={() => setSelectedTask(null)}
                    onCancel={(id) => void handleCancel(id)}
                    onRetry={(id) => void handleRetry(id)}
                />
            )}
        </div>
    );
}
