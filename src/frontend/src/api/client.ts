import type { DashboardData, TaskDetail } from "../types";

const BASE = "/dashboard/api";

async function request<T>(
    path: string,
    options: RequestInit = {}
): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
        headers: { "Content-Type": "application/json", ...options.headers },
        ...options
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw Object.assign(
            new Error(body.error ?? `HTTP ${res.status}`),
            { status: res.status }
        );
    }
    return res.json() as Promise<T>;
}

export const api = {
    /** Check auth by fetching dashboard data. Throws with status 401 if unauth. */
    getData(): Promise<DashboardData> {
        return request<DashboardData>("/data");
    },

    /** Login with password - sets HttpOnly cookie on success */
    async login(password: string): Promise<void> {
        await request<void>("/login", {
            method: "POST",
            body: JSON.stringify({ password })
        });
    },

    /** Get detailed info for a single task */
    getTask(taskId: string): Promise<TaskDetail> {
        return request<TaskDetail>(`/task/${taskId}`);
    },

    /** Create a new task */
    createTask(params: {
        projectId: string;
        prompt: string;
        continueTaskId?: string;
    }): Promise<{ taskId: string; branch: string; status: string }> {
        return request("/task", {
            method: "POST",
            body: JSON.stringify(params)
        });
    },

    /** Cancel a task */
    cancelTask(taskId: string): Promise<void> {
        return request(`/task/${taskId}/cancel`, { method: "POST" });
    },

    /** Retry a task */
    retryTask(taskId: string): Promise<void> {
        return request(`/task/${taskId}/retry`, { method: "POST" });
    },

    /** Retry all failed tasks */
    retryFailed(): Promise<{ retried: number; errors: string[] }> {
        return request("/tasks/retry-failed", { method: "POST" });
    },

    /** Bulk cancel tasks */
    bulkCancel(
        taskIds: string[]
    ): Promise<{ succeeded: number; failed: number; errors: string[] }> {
        return request("/tasks/bulk-cancel", {
            method: "POST",
            body: JSON.stringify({ taskIds })
        });
    },

    /** Bulk retry tasks */
    bulkRetry(
        taskIds: string[]
    ): Promise<{ succeeded: number; failed: number; errors: string[] }> {
        return request("/tasks/bulk-retry", {
            method: "POST",
            body: JSON.stringify({ taskIds })
        });
    }
};
