import { spawn, type ChildProcess } from "node:child_process";
import type { ClaudeCodeConfig } from "./types.js";
import type { TokenManager } from "./auth.js";

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

  constructor(config: ClaudeCodeConfig, tokenManager: TokenManager) {
    this.config = config;
    this.tokenManager = tokenManager;
    this.sandboxImage = process.env.SANDBOX_IMAGE || "implementer-sandbox";
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
      "--name", `${process.env.INSTANCE_NAME || "implementer"}-slug-${taskId ?? Date.now()}`,
      "--cpus=0.5",
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
      "--name", `${process.env.INSTANCE_NAME || "implementer"}-title-${taskId ?? Date.now()}`,
      "--cpus=0.5",
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

    const containerName = `${process.env.INSTANCE_NAME || "implementer"}-${taskId ?? Date.now()}-${this.runCounter++}`;

    const dockerArgs = [
      "run",
      "--rm",
      "--privileged",
      "--name", containerName,
      "--cpus=0.5",
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
