import type { Stats } from "../types";

interface StatsCardsProps {
    stats: Stats;
}

interface Card {
    label: string;
    value: number;
    cls: string;
    show: boolean;
}

export function StatsCards({ stats }: StatsCardsProps) {
    const cards: Card[] = [
        {
            label: "Running",
            value: stats.running + stats.starting + stats.retrying,
            cls: "stat-running",
            show: true
        },
        {
            label: "Queued",
            value: stats.queued,
            cls: "stat-queued",
            show: true
        },
        {
            label: "Completed",
            value: stats.completed,
            cls: "stat-completed",
            show: true
        },
        {
            label: "Failed",
            value: stats.failed + stats.interrupted,
            cls: "stat-failed",
            show: true
        },
        {
            label: "Open PRs",
            value: stats.openPrs,
            cls: "stat-prs",
            show: true
        },
        {
            label: "Draft PRs",
            value: stats.draftPrs,
            cls: "stat-draft",
            show: stats.draftPrs > 0
        }
    ];

    return (
        <div className="stats-grid">
            {cards
                .filter((c) => c.show)
                .map((c) => (
                    <div key={c.label} className={`stat-card ${c.cls}`}>
                        <div className="label">{c.label}</div>
                        <div className="value">{c.value}</div>
                    </div>
                ))}
        </div>
    );
}
