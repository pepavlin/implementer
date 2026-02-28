import type { TaskDetail } from "../types/index.js";

const BASE = "/dashboard/api";

export async function fetchTaskDetail(taskId: string): Promise<TaskDetail> {
    const res = await fetch(`${BASE}/task/${taskId}`);
    if (!res.ok) throw new Error(`Failed to fetch task: ${res.statusText}`);
    return res.json() as Promise<TaskDetail>;
}

export async function createTask(
    projectId: string,
    prompt: string,
    continueTaskId?: string
): Promise<{ taskId: string }> {
    const body: Record<string, string> = { projectId, prompt };
    if (continueTaskId) body.continueTaskId = continueTaskId;

    const res = await fetch(`${BASE}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    const data = (await res.json()) as { taskId?: string; error?: string };
    if (!res.ok || data.error) throw new Error(data.error ?? "Failed to create task");
    return { taskId: data.taskId! };
}

export async function retryTask(taskId: string): Promise<void> {
    const res = await fetch(`${BASE}/task/${taskId}/retry`, { method: "POST" });
    if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Failed to retry task");
    }
}

export async function retryNowTask(taskId: string): Promise<void> {
    const res = await fetch(`${BASE}/task/${taskId}/retry-now`, {
        method: "POST"
    });
    if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Failed to retry task");
    }
}

export async function cancelTask(taskId: string): Promise<void> {
    const res = await fetch(`${BASE}/task/${taskId}/cancel`, { method: "POST" });
    if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Failed to cancel task");
    }
}

export async function retryAllFailed(): Promise<{ retried: number }> {
    const res = await fetch(`${BASE}/tasks/retry-failed`, { method: "POST" });
    const data = (await res.json()) as { retried?: number; error?: string };
    if (!res.ok || data.error) throw new Error(data.error ?? "Failed to retry tasks");
    return { retried: data.retried ?? 0 };
}

export async function bulkCancel(
    taskIds: string[]
): Promise<{ succeeded: number; failed: number }> {
    const res = await fetch(`${BASE}/tasks/bulk-cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds })
    });
    const data = (await res.json()) as {
        succeeded?: number;
        failed?: number;
        error?: string;
    };
    if (!res.ok || data.error) throw new Error(data.error ?? "Failed to cancel tasks");
    return { succeeded: data.succeeded ?? 0, failed: data.failed ?? 0 };
}

export async function bulkRetry(
    taskIds: string[]
): Promise<{ succeeded: number; failed: number }> {
    const res = await fetch(`${BASE}/tasks/bulk-retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds })
    });
    const data = (await res.json()) as {
        succeeded?: number;
        failed?: number;
        error?: string;
    };
    if (!res.ok || data.error) throw new Error(data.error ?? "Failed to retry tasks");
    return { succeeded: data.succeeded ?? 0, failed: data.failed ?? 0 };
}
