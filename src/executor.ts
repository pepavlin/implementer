import { spawn, type ChildProcess } from "node:child_process";
import { nanoid } from "nanoid";
import type { ClaudeCodeConfig } from "./types.js";
import type { TokenManager } from "./auth.js";

/**
 * Stop all sandbox containers from a previous run of this implementer instance
 * that may still be running. Called on startup before resuming interrupted tasks
 * to ensure the total running container count never exceeds maxConcurrentTasks.
 *
 * Containers are matched by the INSTANCE_NAME prefix, e.g. "implementer-".
 * Uses `docker kill` (SIGKILL) since the containers belong to interrupted tasks
 * and will be re-run with fresh containers anyway.
 */
export async function killStaleContainers(): Promise<void> {
    const instanceName = process.env.INSTANCE_NAME || "implementer";
    const nameFilter = `${instanceName}-`;

    return new Promise<void>((resolve) => {
        // List all running containers whose name contains the instance prefix
        const listProc = spawn(
            "docker",
            ["ps", "--filter", `name=${nameFilter}`, "--format", "{{.Names}}"],
            { stdio: ["ignore", "pipe", "pipe"] }
        );

        let output = "";
        listProc.stdout?.on("data", (d: Buffer) => { output += d.toString(); });

        listProc.on("error", (err) => {
            console.warn(`[executor] Failed to list stale containers: ${err.message}`);
            resolve();
        });

        listProc.on("close", () => {
            const containers = output.trim().split("\n").filter(Boolean);
            if (containers.length === 0) {
                console.log("[executor] No stale containers to clean up");
                resolve();
                return;
            }

            console.log(
                `[executor] Killing ${containers.length} stale container(s): ${containers.join(", ")}`
            );

            const killProc = spawn("docker", ["kill", ...containers], {
                stdio: ["ignore", "pipe", "pipe"],
            });

            killProc.on("error", (err) => {
                console.warn(`[executor] Failed to kill stale containers: ${err.message}`);
                resolve();
            });

            killProc.on("close", () => {
                console.log("[executor] Stale containers killed");
                resolve();
            });
        });
    });
}

export interface ExecutorResult {
  exitCode: number | null;
  output: string;
}

/**
 * Extract the last assistant text message from Claude Code stream-json output.
 * Stream-json is NDJSON where assistant messages have: { message: { content: [{ type: "text", text: "..." }] } }
 */
export function extractLastAssistantMessage(streamOutput: string): string {
  let lastText = "";
  for (const line of streamOutput.split("\n")) {
    try {
      const obj = JSON.parse(line);
      const content = obj?.message?.content;
      if (Array.isArray(content)) {
        const texts = content
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text);
        if (texts.length > 0) lastText = texts.join("\n");
      }
    } catch { /* skip non-JSON lines */ }
  }
  return lastText;
}

export class Executor {
  private config: ClaudeCodeConfig;
  private tokenManager: TokenManager;
  private process: ChildProcess | null = null;
  private output = "";
  private runCounter = 0;

  /** Sandbox Docker image name from SANDBOX_IMAGE env var. */
  private sandboxImage: string;

  /**
   * Unique ID for this Executor instance. Included in container names to prevent
   * name collisions when a task is resumed after a server restart — the old container
   * (started by a previous Executor) may still be running, so a fresh Executor must
   * use a different name prefix.
   */
  private instanceId: string;

  constructor(config: ClaudeCodeConfig, tokenManager: TokenManager) {
    this.config = config;
    this.tokenManager = tokenManager;
    this.sandboxImage = process.env.SANDBOX_IMAGE || "implementer-sandbox";
    this.instanceId = nanoid(6);
  }

  getOutput(): string {
    return this.output;
  }

  /**
   * Generate a short branch name slug from the task prompt.
   * Runs a quick Claude call with no tools.
   */
  async generateBranchSlug(prompt: string, taskId?: string): Promise<string> {
    const creds = await this.tokenManager.getCredentials();

    const claudeArgs = [
      "-p",
      `Generate a short git branch name slug (lowercase, hyphens, max 40 chars, no prefix) that describes this task. Reply with ONLY the slug, nothing else.\n\nTask: ${prompt}`,
      "--output-format",
      "text",
      "--model",
      "haiku",
      "--tools",
      "",
    ];

    const dockerArgs = [
      "run",
      "--rm",
      "--name", `${process.env.INSTANCE_NAME || "implementer"}-slug-${taskId ?? Date.now()}-${this.instanceId}`,
      "--cpus=0.4",
      "-e", `${creds.envName}=${creds.value}`,
      this.sandboxImage,
      ...claudeArgs,
    ];

    return new Promise((resolve) => {
      let output = "";
      const proc = spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout?.on("data", (data: Buffer) => { output += data.toString(); });
      proc.stderr?.on("data", (data: Buffer) => { output += data.toString(); });

      proc.on("error", () => resolve("task"));
      proc.on("close", (code) => {
        if (code !== 0) {
          resolve("task");
          return;
        }
        const slug = output
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40);
        resolve(slug || "task");
      });
    });
  }

  /**
   * Generate branch slug and title in a single Docker call to avoid spawning two containers.
   * Uses Claude Haiku with a two-line output format: line 1 = slug, line 2 = title.
   */
  async generateTaskMetadata(prompt: string, taskId?: string): Promise<{ slug: string; title: string }> {
    const creds = await this.tokenManager.getCredentials();

    const claudeArgs = [
      "-p",
      `Reply with EXACTLY two lines and nothing else:
Line 1: a git branch slug (lowercase, hyphens only, max 40 chars)
Line 2: a short human-readable title (max 60 chars)

Task: ${prompt}`,
      "--output-format",
      "text",
      "--model",
      "haiku",
      "--tools",
      "",
    ];

    const dockerArgs = [
      "run",
      "--rm",
      "--name", `${process.env.INSTANCE_NAME || "implementer"}-meta-${taskId ?? Date.now()}-${this.instanceId}`,
      "--cpus=0.4",
      "-e", `${creds.envName}=${creds.value}`,
      this.sandboxImage,
      ...claudeArgs,
    ];

    return new Promise((resolve) => {
      let output = "";
      const proc = spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout?.on("data", (data: Buffer) => { output += data.toString(); });
      proc.stderr?.on("data", (data: Buffer) => { output += data.toString(); });

      proc.on("error", () => resolve({ slug: "task", title: "" }));
      proc.on("close", (code) => {
        if (code !== 0) {
          resolve({ slug: "task", title: "" });
          return;
        }
        const lines = output.trim().split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
        const slug = (lines[0] ?? "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "task";
        const title = (lines[1] ?? "").trim().slice(0, 60);
        resolve({ slug, title });
      });
    });
  }

  /**
   * Generate a short human-readable title from the task prompt.
   * Runs a quick Claude call with no tools.
   */
  async generateTitle(prompt: string, taskId?: string): Promise<string> {
    const creds = await this.tokenManager.getCredentials();

    const claudeArgs = [
      "-p",
      `Generate a short, human-readable title (max 60 chars) for this task. Reply with ONLY the title, nothing else.\n\nTask: ${prompt}`,
      "--output-format",
      "text",
      "--model",
      "haiku",
      "--tools",
      "",
    ];

    const dockerArgs = [
      "run",
      "--rm",
      "--name", `${process.env.INSTANCE_NAME || "implementer"}-title-${taskId ?? Date.now()}-${this.instanceId}`,
      "--cpus=0.4",
      "-e", `${creds.envName}=${creds.value}`,
      this.sandboxImage,
      ...claudeArgs,
    ];

    return new Promise((resolve) => {
      let output = "";
      const proc = spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout?.on("data", (data: Buffer) => { output += data.toString(); });
      proc.stderr?.on("data", (data: Buffer) => { output += data.toString(); });

      proc.on("error", () => resolve(""));
      proc.on("close", (code) => {
        if (code !== 0) {
          resolve("");
          return;
        }
        resolve(output.trim().slice(0, 60) || "");
      });
    });
  }

  /**
   * Run Claude Code CLI inside a Docker container with the workspace mounted.
   */
  async run(prompt: string, volumeMount: string, workdir = "/workspace", taskId?: string): Promise<ExecutorResult> {
    this.output = "";

    const creds = await this.tokenManager.getCredentials();

    const claudeArgs = [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    if (this.config.model) {
      claudeArgs.push("--model", this.config.model);
    }

    const containerName = `${process.env.INSTANCE_NAME || "implementer"}-${taskId ?? Date.now()}-${this.instanceId}-${this.runCounter++}`;

    const dockerArgs = [
      "run",
      "--rm",
      "--privileged",
      "--name", containerName,
      "--cpus=0.4",
      "-v", volumeMount,
      "-w", workdir,
      "-e", `${creds.envName}=${creds.value}`,
      ...(this.config.maxOutputTokens
        ? ["-e", `CLAUDE_CODE_MAX_OUTPUT_TOKENS=${this.config.maxOutputTokens}`]
        : []),
      this.sandboxImage,
      ...claudeArgs,
    ];

    return new Promise((resolve, reject) => {
      const proc = spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.process = proc;

      proc.stdout?.on("data", (data: Buffer) => {
        this.output += data.toString();
      });

      proc.stderr?.on("data", (data: Buffer) => {
        this.output += data.toString();
      });

      proc.on("error", (err) => {
        this.process = null;
        reject(new Error(`Failed to start Docker container: ${err.message}`));
      });

      proc.on("close", (code) => {
        this.process = null;
        resolve({
          exitCode: code,
          output: this.output,
        });
      });
    });
  }

  kill(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }
}
