import { useState, type KeyboardEvent } from "react";
import { api } from "../api/client";

interface NewTaskFormProps {
    projects: string[];
    onCreated: () => void;
}

export function NewTaskForm({ projects, onCreated }: NewTaskFormProps) {
    const [projectId, setProjectId] = useState(projects[0] ?? "");
    const [prompt, setPrompt] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit() {
        const p = prompt.trim();
        if (!p || !projectId) return;
        setLoading(true);
        setError(null);
        try {
            await api.createTask({ projectId, prompt: p });
            setPrompt("");
            onCreated();
        } catch (err: unknown) {
            const e = err as { message?: string };
            setError(e.message ?? "Failed to create task");
        } finally {
            setLoading(false);
        }
    }

    function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
        }
    }

    return (
        <div className="new-task-form">
            <div className="new-task-row">
                <select
                    className="new-task-select"
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    disabled={loading}
                >
                    {projects.map((p) => (
                        <option key={p} value={p}>{p}</option>
                    ))}
                </select>
                <textarea
                    className="new-task-textarea"
                    placeholder="Task prompt… (Ctrl+Enter to submit)"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={loading}
                    rows={1}
                />
                <button
                    className="btn btn-primary"
                    onClick={() => void submit()}
                    disabled={loading || !prompt.trim() || !projectId}
                >
                    {loading ? "…" : "Submit"}
                </button>
            </div>
            {error && <div className="error-msg">{error}</div>}
        </div>
    );
}
