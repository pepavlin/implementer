import { Mic, Check, X } from "lucide-react";
import type { ProjectStats } from "../types/index.js";

interface ProjectFilterProps {
    projects: Record<string, ProjectStats>;
    selectedProject: string | null;
    onSelect: (projectId: string | null) => void;
    voiceMode: boolean;
    voiceTarget: string | null;
    onVoiceSelect: (projectId: string) => void;
}

function ProjectCard({
    projectId,
    stats,
    selected,
    voiceMode,
    isVoiceTarget,
    onSelect,
    onVoiceSelect
}: {
    projectId: string;
    stats: ProjectStats;
    selected: boolean;
    voiceMode: boolean;
    isVoiceTarget: boolean;
    onSelect: () => void;
    onVoiceSelect: () => void;
}) {
    const isActive = (stats.running ?? 0) + (stats.starting ?? 0) > 0;
    const isQueued = (stats.queued ?? 0) + (stats.retrying ?? 0) > 0;

    const classNames = [
        "proj-card",
        selected ? "selected" : "",
        isActive ? "proj-active" : "",
        isQueued && !isActive ? "proj-queued" : "",
        isVoiceTarget ? "voice-target" : ""
    ]
        .filter(Boolean)
        .join(" ");

    const handleClick = () => {
        if (voiceMode) {
            onVoiceSelect();
        } else {
            onSelect();
        }
    };

    return (
        <div className={classNames} onClick={handleClick}>
            <div className="proj-name">
                {isVoiceTarget && <Mic size={11} style={{ verticalAlign: "middle", marginRight: 4 }} />}
                {projectId}
            </div>
            <div className="proj-stats">
                {(stats.running ?? 0) + (stats.starting ?? 0) > 0 && (
                    <span className="ps ps-running">
                        <span className="badge-spin" />
                        {(stats.running ?? 0) + (stats.starting ?? 0)}
                    </span>
                )}
                {(stats.queued ?? 0) > 0 && (
                    <span className="ps ps-queued">{stats.queued} Q</span>
                )}
                {(stats.retrying ?? 0) > 0 && (
                    <span className="ps ps-retrying">{stats.retrying} R</span>
                )}
                {(stats.completed ?? 0) > 0 && (
                    <span className="ps ps-completed"><Check size={9} style={{ verticalAlign: "middle" }} /> {stats.completed}</span>
                )}
                {(stats.failed ?? 0) > 0 && (
                    <span className="ps ps-failed"><X size={9} style={{ verticalAlign: "middle" }} /> {stats.failed}</span>
                )}
            </div>
        </div>
    );
}

export function ProjectFilter({
    projects,
    selectedProject,
    onSelect,
    voiceMode,
    voiceTarget,
    onVoiceSelect
}: ProjectFilterProps) {
    const projectIds = Object.keys(projects);
    if (projectIds.length === 0) return null;

    const hint = voiceMode
        ? voiceTarget
            ? `Listening — ${voiceTarget}. Speak your task…`
            : "Voice Mode — click a project to start dictating"
        : selectedProject
          ? `Showing tasks for ${selectedProject}`
          : "";

    return (
        <div>
            <div className="section-title">Projects</div>
            <div className="projects">
                {projectIds.map((id) => (
                    <ProjectCard
                        key={id}
                        projectId={id}
                        stats={projects[id]}
                        selected={selectedProject === id}
                        voiceMode={voiceMode}
                        isVoiceTarget={voiceTarget === id}
                        onSelect={() => onSelect(selectedProject === id ? null : id)}
                        onVoiceSelect={() => onVoiceSelect(id)}
                    />
                ))}
            </div>
            {hint && <div className="proj-hint">{hint}</div>}
        </div>
    );
}
