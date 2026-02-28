import type { Stats } from "../types/index.js";

interface StatsBarProps {
    stats: Stats;
    onOpenPrsClick: () => void;
}

export function StatsBar({ stats, onOpenPrsClick }: StatsBarProps) {
    const activeRunning = stats.running + stats.starting > 0;
    const activeQueued = stats.queued + stats.retrying > 0;

    return (
        <div className="stats">
            <div className={`stat${activeRunning ? " stat-has-running" : ""}`}>
                <div className="stat-label cr">
                    {activeRunning && <span className="stat-active-dot cr" />}
                    Running
                </div>
                <div className="stat-val cr">{stats.running + stats.starting}</div>
            </div>

            <div className={`stat${activeQueued ? " stat-has-queued" : ""}`}>
                <div className="stat-label cq">
                    {activeQueued && <span className="stat-active-dot cq" />}
                    Queued
                </div>
                <div className="stat-val cq">{stats.queued + stats.retrying}</div>
            </div>

            <div className="stat">
                <div className="stat-label cc">Completed</div>
                <div className="stat-val cc">{stats.completed}</div>
            </div>

            <div className="stat">
                <div className="stat-label cf">Failed</div>
                <div className="stat-val cf">{stats.failed}</div>
            </div>

            {stats.openPrs > 0 && (
                <div
                    className="open-prs-panel"
                    onClick={onOpenPrsClick}
                    title="Filter to open PRs"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && onOpenPrsClick()}
                >
                    <div className="open-prs-label">Open PRs</div>
                    <div className="open-prs-count">{stats.openPrs}</div>
                </div>
            )}
        </div>
    );
}
