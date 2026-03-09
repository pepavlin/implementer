import type { TaskId, TaskStatus } from "../types.js";
import { extractLastAssistantMessage } from "../executor.js";

const SUMMARY_MAX_LENGTH = 500;

export interface ChainTaskInfo {
    prompt: string;
    status: TaskStatus;
    output: string;
}

/**
 * Build a textual summary of previous tasks in a chain so Claude
 * has context about what was already implemented on this branch.
 * Returns empty string when there is no chain history.
 */
export function buildChainHistory(ancestors: ChainTaskInfo[]): string {
    if (ancestors.length === 0) return "";

    const sections = ancestors.map((t, i) => {
        const title = t.prompt.split("\n")[0].slice(0, 120);
        const summary = extractLastAssistantMessage(t.output).trim().slice(0, SUMMARY_MAX_LENGTH);
        return `### Task ${i + 1}: "${title}"
Status: ${t.status}
${summary ? `Summary: ${summary}` : "No summary available."}`;
    });

    return `

## Previous tasks in this chain (oldest first):

${sections.join("\n\n")}

---`;
}

export function buildSystemInstructions(
    repos: { name: string }[],
    protectedPaths?: string[]
): string {
    const repoList = repos.map((r) => r.name).join(", ");
    const protectedRule =
        protectedPaths && protectedPaths.length > 0
            ? `\n- The following paths are PROTECTED and must NEVER be modified, created, or deleted: ${protectedPaths.join(", ")}. Do not make any changes to files matching these patterns under any circumstances.`
            : "";
    return `

IMPORTANT WORKSPACE RULES:
- Your workspace contains the following git repositories: ${repoList}. Always work INSIDE the repository directory (e.g. cd ${repos[0]?.name ?? "repo"} first). Do NOT create new git repositories or run git init.
- After making all changes, you MUST commit them using git. Stage your changes with "git add" and commit with "git commit". Write clear and descriptive commit messages using conventional commits format (e.g. "feat: add animated hero section with cat image", "fix: resolve navigation hover styles"). Each commit should be a logical unit of work with a message that explains what was done and why. Do NOT push — only commit.
- When you need to visually inspect a web application, ALWAYS start the dev server locally first (e.g. npm start, npm run dev) and use Playwright on the local URL (http://localhost:...). NEVER screenshot external/production URLs — you must test against the local code in your workspace so your changes are reflected.${protectedRule}
- At the very end of your response, write a concise 2-3 sentence summary of what you implemented or changed. Do not repeat the full details — just the key outcome.`;
}

/**
 * Build the PR description body from the original task prompt.
 * This becomes the main pull request description so reviewers immediately
 * see what was requested.
 */
export function buildPrDescription(prompt: string): string {
    return `## Task\n\n${prompt}`;
}

/**
 * Build the PR result comment from Claude's summary and commit logs.
 * Posted as a comment after PR creation so the outcome is visible
 * alongside the original task description.
 */
export function buildPrBody(
    assistantMessage: string,
    commitLogs: Map<string, string>
): string {
    const parts: string[] = [];

    if (assistantMessage) {
        parts.push(`## Summary\n\n${assistantMessage}`);
    }

    if (commitLogs.size > 0) {
        const commitLines = Array.from(commitLogs.values()).join("\n");
        parts.push(`## Commits\n\n${commitLines}`);
    }

    return parts.join("\n\n") || "No summary available.";
}

/**
 * Compute the Docker -v mount and -w workdir for a sandbox container.
 *
 * Three modes:
 * - Volume mode (WORKSPACE_VOLUME set): mount named volume, workdir = subpath inside it
 * - Bind mount mode (WORKSPACE_HOST_DIR set): bind mount host path
 * - Native mode (neither set): bind mount local path directly
 */
export function getDockerMount(
    workspaceDir: string,
    serverWorkspaceDir: string
): { volumeMount: string; workdir: string } {
    const volume = process.env.WORKSPACE_VOLUME;
    if (volume) {
        const relativePath = workspaceDir.replace(serverWorkspaceDir, "");
        return {
            volumeMount: `${volume}:/workspace`,
            workdir: `/workspace${relativePath}`
        };
    }

    const hostDir = process.env.WORKSPACE_HOST_DIR;
    if (hostDir) {
        const hostPath = workspaceDir.replace(serverWorkspaceDir, hostDir);
        return {
            volumeMount: `${hostPath}:/workspace`,
            workdir: "/workspace"
        };
    }

    return {
        volumeMount: `${workspaceDir}:/workspace`,
        workdir: "/workspace"
    };
}

export function fireWebhook(taskId: TaskId, status: string, url: string): void {
    fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, status })
    }).catch((err) => {
        console.error(
            `[${taskId}] Webhook POST to ${url} failed:`,
            err instanceof Error ? err.message : String(err)
        );
    });
}
