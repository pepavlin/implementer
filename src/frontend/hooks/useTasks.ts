import { useState, useEffect, useRef, useCallback } from "react";
import type { DashboardData } from "../types/index.js";

interface UseTasksResult {
    data: DashboardData | null;
    connected: boolean;
    lastUpdated: Date | null;
    refresh: () => void;
}

export function useTasks(): UseTasksResult {
    const [data, setData] = useState<DashboardData | null>(null);
    const [connected, setConnected] = useState(false);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const esRef = useRef<EventSource | null>(null);

    const connect = useCallback(() => {
        if (esRef.current) {
            esRef.current.close();
        }

        const es = new EventSource("/dashboard/events");
        esRef.current = es;

        es.onopen = () => setConnected(true);

        es.onmessage = (evt) => {
            try {
                const parsed = JSON.parse(evt.data) as DashboardData;
                setData(parsed);
                setLastUpdated(new Date());
                setConnected(true);
            } catch {
                // ignore parse errors
            }
        };

        es.onerror = () => {
            setConnected(false);
            // EventSource auto-reconnects, no need to manually retry
        };
    }, []);

    useEffect(() => {
        connect();
        return () => {
            esRef.current?.close();
        };
    }, [connect]);

    const refresh = useCallback(() => {
        // Force a reconnect to get fresh data immediately
        connect();
    }, [connect]);

    return { data, connected, lastUpdated, refresh };
}
