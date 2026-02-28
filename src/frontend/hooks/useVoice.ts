import { useState, useRef, useCallback, useEffect } from "react";
import { createTask } from "../api/client.js";

export interface VoiceSubmittedItem {
    project: string;
    prompt: string;
    taskId: string;
    time: string;
}

interface UseVoiceResult {
    voiceMode: boolean;
    voiceTarget: string | null;
    voiceTranscript: string;
    voiceLang: string;
    voiceSubmittedLog: VoiceSubmittedItem[];
    silenceProgress: number;
    warning: string | null;
    toggleVoiceMode: () => void;
    voiceSelectProject: (projectId: string) => void;
    voiceCancel: () => void;
    toggleVoiceLang: () => void;
    clearWarning: () => void;
}

const SILENCE_DURATION = 6000;

export function useVoice(): UseVoiceResult {
    const [voiceMode, setVoiceMode] = useState(false);
    const [voiceTarget, setVoiceTarget] = useState<string | null>(null);
    const [voiceTranscript, setVoiceTranscript] = useState("");
    const [voiceLang, setVoiceLang] = useState("cs-CZ");
    const [voiceSubmittedLog, setVoiceSubmittedLog] = useState<VoiceSubmittedItem[]>([]);
    const [silenceProgress, setSilenceProgress] = useState(0);
    const [warning, setWarning] = useState<string | null>(null);

    const recognitionRef = useRef<SpeechRecognition | null>(null);
    const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const silenceStartRef = useRef<number>(0);
    const voiceTargetRef = useRef<string | null>(null);
    const voiceModeRef = useRef(false);
    const voiceLangRef = useRef(voiceLang);
    const voiceTranscriptRef = useRef("");

    // Keep refs in sync with state
    useEffect(() => { voiceTargetRef.current = voiceTarget; }, [voiceTarget]);
    useEffect(() => { voiceModeRef.current = voiceMode; }, [voiceMode]);
    useEffect(() => { voiceLangRef.current = voiceLang; }, [voiceLang]);
    useEffect(() => { voiceTranscriptRef.current = voiceTranscript; }, [voiceTranscript]);

    const clearSilenceTimer = useCallback(() => {
        if (silenceTimerRef.current) {
            clearInterval(silenceTimerRef.current);
            silenceTimerRef.current = null;
        }
        setSilenceProgress(0);
    }, []);

    const stopRecognition = useCallback(() => {
        clearSilenceTimer();
        if (recognitionRef.current) {
            try { recognitionRef.current.abort(); } catch { /* ignore */ }
            recognitionRef.current = null;
        }
    }, [clearSilenceTimer]);

    const voiceAutoSubmit = useCallback(async () => {
        const transcript = voiceTranscriptRef.current.trim();
        const target = voiceTargetRef.current;
        if (!transcript || !target) return;

        stopRecognition();
        try {
            const result = await createTask(target, transcript);
            setVoiceSubmittedLog((prev) => [
                {
                    project: target,
                    prompt: transcript,
                    taskId: result.taskId,
                    time: new Date().toLocaleTimeString()
                },
                ...prev.slice(0, 4)
            ]);
            setVoiceTranscript("");
            setVoiceTarget(null);
        } catch (e) {
            setWarning(`Failed to submit task: ${e instanceof Error ? e.message : String(e)}`);
        }
    }, [stopRecognition]);

    const startSilenceTimer = useCallback(() => {
        clearSilenceTimer();
        silenceStartRef.current = Date.now();
        silenceTimerRef.current = setInterval(() => {
            const elapsed = Date.now() - silenceStartRef.current;
            const pct = Math.min(100, Math.round((elapsed / SILENCE_DURATION) * 100));
            setSilenceProgress(pct);
            if (elapsed >= SILENCE_DURATION) {
                clearSilenceTimer();
                void voiceAutoSubmit();
            }
        }, 100);
    }, [clearSilenceTimer, voiceAutoSubmit]);

    const startRecognition = useCallback(() => {
        stopRecognition();
        const SR =
            (window as typeof window & { SpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition ||
            (window as typeof window & { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;

        if (!SR) {
            setWarning("Speech recognition is not supported in this browser. Please use Chrome.");
            return;
        }

        const recognition = new SR();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = voiceLangRef.current;
        recognitionRef.current = recognition;

        recognition.onresult = (event: SpeechRecognitionEvent) => {
            let transcript = "";
            for (let i = 0; i < event.results.length; i++) {
                transcript += event.results[i][0].transcript;
            }
            setVoiceTranscript(transcript);
            if (transcript.trim()) startSilenceTimer();
        };

        recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
            if (event.error === "no-speech" || event.error === "aborted") return;
            console.warn("Speech recognition error:", event.error);
        };

        recognition.onend = () => {
            if (voiceModeRef.current && voiceTargetRef.current) {
                try { recognition.start(); } catch { /* ignore */ }
            }
        };

        try { recognition.start(); } catch (e) {
            console.warn("Failed to start speech recognition:", e);
        }
    }, [stopRecognition, startSilenceTimer]);

    const toggleVoiceMode = useCallback(() => {
        setVoiceMode((prev) => {
            if (!prev) {
                return true;
            } else {
                stopRecognition();
                setVoiceTarget(null);
                setVoiceTranscript("");
                setVoiceSubmittedLog([]);
                return false;
            }
        });
    }, [stopRecognition]);

    const voiceSelectProject = useCallback(
        (projectId: string) => {
            if (voiceTargetRef.current === projectId) {
                stopRecognition();
                setVoiceTarget(null);
                setVoiceTranscript("");
                return;
            }
            setVoiceTarget(projectId);
            setVoiceTranscript("");
            setWarning(null);
            startRecognition();
        },
        [stopRecognition, startRecognition]
    );

    const voiceCancel = useCallback(() => {
        stopRecognition();
        setVoiceTranscript("");
        setVoiceTarget(null);
        setWarning(null);
    }, [stopRecognition]);

    const toggleVoiceLang = useCallback(() => {
        setVoiceLang((prev) => {
            const next = prev === "cs-CZ" ? "en-US" : "cs-CZ";
            voiceLangRef.current = next;
            if (recognitionRef.current && voiceTargetRef.current) {
                startRecognition();
            }
            return next;
        });
    }, [startRecognition]);

    const clearWarning = useCallback(() => setWarning(null), []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            stopRecognition();
        };
    }, [stopRecognition]);

    return {
        voiceMode,
        voiceTarget,
        voiceTranscript,
        voiceLang,
        voiceSubmittedLog,
        silenceProgress,
        warning,
        toggleVoiceMode,
        voiceSelectProject,
        voiceCancel,
        toggleVoiceLang,
        clearWarning
    };
}
