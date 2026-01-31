import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import type { ClaudeCodeConfig } from "./types.js";

export interface ExecutorResult {
  exitCode: number | null;
  output: string;
}

/**
 * Extract Claude OAuth credentials from macOS Keychain.
 * Falls back to CLAUDE_CODE_OAUTH_TOKEN env var if set.
 */
function getClaudeCredentials(): string {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  try {
    const creds = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf-8" }
    ).trim();

    // The keychain stores JSON with OAuth tokens - extract the access token
    const parsed = JSON.parse(creds);
    return parsed.claudeAiOauth?.accessToken ?? "";
  } catch {
    throw new Error(
      "Could not retrieve Claude credentials. Set CLAUDE_CODE_OAUTH_TOKEN env var or run 'claude setup-token'."
    );
  }
}

export class Executor {
  private config: ClaudeCodeConfig;
  private process: ChildProcess | null = null;
  private output = "";

  constructor(config: ClaudeCodeConfig) {
    this.config = config;
  }

  getOutput(): string {
    return this.output;
  }

  /**
   * Generate a short branch name slug from the task prompt.
   * Runs a quick Claude call with no tools.
   */
  generateBranchSlug(prompt: string): Promise<string> {
    const oauthToken = getClaudeCredentials();

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
      "-e", `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`,
      this.config.dockerImage,
      ...claudeArgs,
    ];

    return new Promise((resolve, reject) => {
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
   *
   * @param prompt - The prompt to send to Claude Code
   * @param volumeMount - The -v argument (e.g. "/host/path:/workspace" or "vol_name:/workspace")
   * @param workdir - The -w argument (working directory inside the container, defaults to "/workspace")
   */
  run(prompt: string, volumeMount: string, workdir = "/workspace"): Promise<ExecutorResult> {
    this.output = "";

    const oauthToken = getClaudeCredentials();

    const claudeArgs = [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      "--output-format",
      "json",
    ];

    if (this.config.model) {
      claudeArgs.push("--model", this.config.model);
    }

    const dockerArgs = [
      "run",
      "--rm",
      "-v", volumeMount,
      "-w", workdir,
      "-e", `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`,
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
