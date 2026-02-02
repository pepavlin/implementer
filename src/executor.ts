import { spawn, type ChildProcess } from "node:child_process";
import type { ClaudeCodeConfig } from "./types.js";
import type { TokenManager } from "./auth.js";

export interface ExecutorResult {
  exitCode: number | null;
  output: string;
}

export class Executor {
  private config: ClaudeCodeConfig;
  private tokenManager: TokenManager;
  private process: ChildProcess | null = null;
  private output = "";
  private runCounter = 0;

  constructor(config: ClaudeCodeConfig, tokenManager: TokenManager) {
    this.config = config;
    this.tokenManager = tokenManager;
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
      "--name", `implementer-slug-${taskId ?? Date.now()}`,
      "-e", `${creds.envName}=${creds.value}`,
      this.config.dockerImage,
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

    const containerName = `implementer-${taskId ?? Date.now()}-${this.runCounter++}`;

    const dockerArgs = [
      "run",
      "--rm",
      "--name", containerName,
      "-v", volumeMount,
      "-w", workdir,
      "-e", `${creds.envName}=${creds.value}`,
      this.config.dockerImage,
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
