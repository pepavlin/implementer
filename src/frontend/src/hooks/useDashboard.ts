import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api/client";
import type { DashboardData } from "../types";

const POLL_INTERVAL = 3000;

export type AuthState = "loading" | "unauthenticated" | "authenticated";

export function useDashboard() {
    const [authState, setAuthState] = useState<AuthState>("loading");
    const [data, setData] = useState<DashboardData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const fetchData = useCallback(async (silent = false) => {
        try {
            const result = await api.getData();
            setData(result);
            setAuthState("authenticated");
            if (!silent) setError(null);
        } catch (err: unknown) {
            const e = err as { status?: number; message?: string };
            if (e.status === 401) {
                setAuthState("unauthenticated");
                setData(null);
            } else {
                if (!silent) setError(e.message ?? "Failed to fetch data");
            }
        }
    }, []);

    // Initial fetch
    useEffect(() => {
        void fetchData(false);
    }, [fetchData]);

    // Polling when authenticated
    useEffect(() => {
        if (authState !== "authenticated") {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
            return;
        }
        intervalRef.current = setInterval(() => void fetchData(true), POLL_INTERVAL);
        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, [authState, fetchData]);

    const login = useCallback(async (password: string) => {
        await api.login(password);
        await fetchData(false);
    }, [fetchData]);

    const logout = useCallback(() => {
        window.location.href = "/dashboard/logout";
    }, []);

    const refresh = useCallback(() => void fetchData(false), [fetchData]);

    return { authState, data, error, login, logout, refresh };
}
