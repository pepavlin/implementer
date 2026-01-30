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
   * Run Claude Code CLI inside a Docker container with only the workspace mounted.
   */
  run(prompt: string, cwd: string, allowedTools: string[]): Promise<ExecutorResult> {
    this.output = "";

    const oauthToken = getClaudeCredentials();

    const claudeArgs = [
      "-p",
      prompt,
      "--allowedTools",
      allowedTools.join(","),
      "--dangerously-skip-permissions",
      "--output-format",
      "json",
    ];

    if (this.config.model) {
      claudeArgs.push("--model", this.config.model);
    }

    // Docker run args:
    // - Mount only the repo workspace at /workspace
    // - Pass OAuth token as env var
    // - Remove container after exit
    // - No extra capabilities, no host network access beyond what's needed for API
    const dockerArgs = [
      "run",
      "--rm",
      "-v", `${cwd}:/workspace`,
      "-w", "/workspace",
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
