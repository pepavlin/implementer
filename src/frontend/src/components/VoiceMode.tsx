import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api/client";

interface VoiceModeProps {
    projects: string[];
    onTaskCreated: () => void;
}

type Lang = "cs-CZ" | "en-US";

interface SubmittedEntry {
    project: string;
    prompt: string;
    taskId: string;
    time: string;
}

export function VoiceMode({ projects, onTaskCreated }: VoiceModeProps) {
    const [target, setTarget] = useState<string | null>(null);
    const [transcript, setTranscript] = useState("");
    const [lang, setLang] = useState<Lang>("en-US");
    const [submitted, setSubmitted] = useState<SubmittedEntry[]>([]);
    const [progress, setProgress] = useState(0);
    const [warning, setWarning] = useState<string | null>(null);

    const recognitionRef = useRef<SpeechRecognition | null>(null);
    const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const silenceStartRef = useRef<number>(0);
    const transcriptRef = useRef(transcript);
    transcriptRef.current = transcript;

    const clearSilenceTimer = useCallback(() => {
        if (silenceTimerRef.current) {
            clearInterval(silenceTimerRef.current);
            silenceTimerRef.current = null;
        }
        setProgress(0);
    }, []);

    const stopRecognition = useCallback(() => {
        clearSilenceTimer();
        if (recognitionRef.current) {
            try { recognitionRef.current.abort(); } catch { /* ignore */ }
            recognitionRef.current = null;
        }
    }, [clearSilenceTimer]);

    const autoSubmit = useCallback(async () => {
        const t = transcriptRef.current.trim();
        if (!t || !target) return;
        stopRecognition();
        try {
            const result = await api.createTask({ projectId: target, prompt: t });
            setSubmitted((prev) => [
                { project: target, prompt: t, taskId: result.taskId, time: new Date().toLocaleTimeString() },
                ...prev.slice(0, 9)
            ]);
            setTranscript("");
            setTarget(null);
            onTaskCreated();
        } catch (err: unknown) {
            const e = err as { message?: string };
            setWarning(`Failed: ${e.message ?? "Unknown error"}`);
        }
    }, [target, stopRecognition, onTaskCreated]);

    const startSilenceTimer = useCallback(() => {
        clearSilenceTimer();
        silenceStartRef.current = Date.now();
        const duration = 6000;
        silenceTimerRef.current = setInterval(() => {
            const elapsed = Date.now() - silenceStartRef.current;
            const pct = Math.min(100, Math.round((elapsed / duration) * 100));
            setProgress(pct);
            if (elapsed >= duration) {
                clearSilenceTimer();
                void autoSubmit();
            }
        }, 100);
    }, [clearSilenceTimer, autoSubmit]);

    const startRecognition = useCallback(() => {
        stopRecognition();
        const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
        if (!SR) {
            setWarning("Speech recognition is not supported. Please use Chrome.");
            return;
        }
        const rec = new SR();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = lang;
        rec.onresult = (event) => {
            let t = "";
            for (let i = 0; i < event.results.length; i++) {
                t += event.results[i][0].transcript;
            }
            setTranscript(t);
            if (t.trim()) startSilenceTimer();
        };
        rec.onerror = (event) => {
            if (event.error === "no-speech" || event.error === "aborted") return;
            console.warn("Speech recognition error:", event.error);
        };
        rec.onend = () => {
            if (recognitionRef.current === rec && target) {
                try { rec.start(); } catch { /* ignore */ }
            }
        };
        try { rec.start(); } catch { /* ignore */ }
        recognitionRef.current = rec;
    }, [lang, target, stopRecognition, startSilenceTimer]);

    // Start/stop recognition when target changes
    useEffect(() => {
        if (target) {
            startRecognition();
        } else {
            stopRecognition();
            setTranscript("");
            clearSilenceTimer();
        }
        return () => { stopRecognition(); };
    }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

    // Restart recognition when lang changes (if active)
    useEffect(() => {
        if (target) startRecognition();
    }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className="voice-panel">
            <div className="voice-panel-header">
                <span className="voice-panel-title">Voice Mode</span>
                {target && <div className="voice-recording-dot" />}
                <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setLang((l) => l === "cs-CZ" ? "en-US" : "cs-CZ")}
                    title="Toggle language"
                >
                    {lang === "cs-CZ" ? "🇨🇿 CS" : "🇬🇧 EN"}
                </button>
            </div>

            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
                Select a project to start recording:
            </div>
            <div className="project-section" style={{ marginBottom: 10 }}>
                {projects.map((p) => (
                    <button
                        key={p}
                        className={`project-pill ${target === p ? "active" : ""}`}
                        onClick={() => setTarget(target === p ? null : p)}
                    >
                        {p}
                    </button>
                ))}
            </div>

            <div className={`voice-transcript ${!transcript ? "empty" : ""}`}>
                {transcript || (target ? "Listening…" : "No project selected")}
            </div>

            <div className="voice-progress">
                <div className="voice-progress-fill" style={{ width: `${progress}%` }} />
            </div>

            {warning && (
                <div className="error-msg" style={{ marginBottom: 8 }}>{warning}</div>
            )}

            <div className="voice-actions">
                <button
                    className="btn btn-primary btn-sm"
                    disabled={!transcript.trim() || !target}
                    onClick={() => void autoSubmit()}
                >
                    Submit
                </button>
                <button
                    className="btn btn-ghost btn-sm"
                    disabled={!transcript && !target}
                    onClick={() => { setTarget(null); setTranscript(""); setWarning(null); }}
                >
                    Cancel
                </button>
            </div>

            {submitted.length > 0 && (
                <div className="voice-submitted">
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        Recently submitted
                    </div>
                    {submitted.map((s, i) => (
                        <div key={i} className="voice-submitted-item">
                            <span className="voice-submitted-time">{s.time}</span>
                            <span style={{ color: "var(--accent)" }}>{s.project}</span>
                            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {s.prompt}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
