import { spawn, type ChildProcess } from "node:child_process";
import type { ClaudeCodeConfig } from "./types.js";

export interface ExecutorResult {
  exitCode: number | null;
  output: string;
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
   * Run Claude Code CLI with the given prompt in the specified directory.
   * Returns a promise that resolves when the process exits.
   */
  run(prompt: string, cwd: string, allowedTools: string[]): Promise<ExecutorResult> {
    this.output = "";

    const args = [
      "-p",
      prompt,
      "--allowedTools",
      allowedTools.join(","),
      "--max-turns",
      String(this.config.maxTurns),
      "--output-format",
      "json",
    ];

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.command, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
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
        reject(new Error(`Failed to start Claude Code: ${err.message}`));
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

  /**
   * Kill the running process if any.
   */
  kill(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }
}
