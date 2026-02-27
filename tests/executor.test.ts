import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as child_process from "node:child_process";
import { EventEmitter } from "node:events";
import type { ClaudeCodeConfig } from "../src/types.js";
import { TokenManager } from "../src/auth.js";
import { Executor, extractLastAssistantMessage } from "../src/executor.js";

// Mock child_process.spawn to capture docker args without running containers
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof child_process>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});

const spawnMock = vi.mocked(child_process.spawn);

function makeFakeProc(exitCode: number | null = 0, autoClose = true): child_process.ChildProcess {
  const proc = new EventEmitter() as child_process.ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(proc, { stdout, stderr, stdin: null, stdio: [null, stdout, stderr], pid: 123, kill: vi.fn() });
  if (autoClose) {
    // Emit close on next tick so the promise resolves
    setTimeout(() => proc.emit("close", exitCode), 10);
  }
  return proc;
}

function makeConfig(overrides: Partial<ClaudeCodeConfig> = {}): ClaudeCodeConfig {
  return { command: "claude", ...overrides };
}

function makeTokenManager(): TokenManager {
  const tm = new TokenManager(undefined, "/tmp/executor-test");
  // Stub getCredentials to avoid real token lookups
  vi.spyOn(tm, "getCredentials").mockResolvedValue({
    envName: "ANTHROPIC_API_KEY",
    value: "test-key",
  });
  return tm;
}

describe("extractLastAssistantMessage", () => {
  it("extracts text from a single assistant message", () => {
    const output = '{"message":{"content":[{"type":"text","text":"I made the changes."}]}}';
    expect(extractLastAssistantMessage(output)).toBe("I made the changes.");
  });

  it("returns the last assistant message when multiple exist", () => {
    const lines = [
      '{"message":{"content":[{"type":"text","text":"Starting work..."}]}}',
      '{"type":"tool_use","name":"bash"}',
      '{"message":{"content":[{"type":"text","text":"All done! Created the component."}]}}',
    ].join("\n");
    expect(extractLastAssistantMessage(lines)).toBe("All done! Created the component.");
  });

  it("joins multiple text blocks in a single message", () => {
    const output = '{"message":{"content":[{"type":"text","text":"Part 1"},{"type":"text","text":"Part 2"}]}}';
    expect(extractLastAssistantMessage(output)).toBe("Part 1\nPart 2");
  });

  it("skips non-text content blocks", () => {
    const output = '{"message":{"content":[{"type":"tool_use","name":"bash"},{"type":"text","text":"Result here"}]}}';
    expect(extractLastAssistantMessage(output)).toBe("Result here");
  });

  it("returns empty string for empty input", () => {
    expect(extractLastAssistantMessage("")).toBe("");
  });

  it("returns empty string when no assistant messages found", () => {
    const lines = [
      '{"type":"tool_result","output":"ok"}',
      '{"system":"initialized"}',
      "not json at all",
    ].join("\n");
    expect(extractLastAssistantMessage(lines)).toBe("");
  });

  it("skips malformed JSON lines gracefully", () => {
    const lines = [
      "this is not json",
      '{"message":{"content":[{"type":"text","text":"Valid message"}]}}',
      "{broken json",
    ].join("\n");
    expect(extractLastAssistantMessage(lines)).toBe("Valid message");
  });

  it("ignores messages with empty content array", () => {
    const lines = [
      '{"message":{"content":[]}}',
      '{"message":{"content":[{"type":"text","text":"Real message"}]}}',
    ].join("\n");
    expect(extractLastAssistantMessage(lines)).toBe("Real message");
  });
});

describe("Executor", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    spawnMock.mockReset();
    process.env.INSTANCE_NAME = "test-impl";
    process.env.SANDBOX_IMAGE = "test-sandbox";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("run", () => {
    it("passes --privileged flag for Docker-in-Docker support", async () => {
      spawnMock.mockReturnValue(makeFakeProc(0));

      const executor = new Executor(makeConfig(), makeTokenManager());
      await executor.run("test prompt", "vol:/workspace", "/workspace", "task-1");

      expect(spawnMock).toHaveBeenCalledOnce();
      const [cmd, args] = spawnMock.mock.calls[0];
      expect(cmd).toBe("docker");
      expect(args).toContain("--privileged");
    });

    it("includes --cpus, volume mount, and workdir in docker args", async () => {
      spawnMock.mockReturnValue(makeFakeProc(0));

      const executor = new Executor(makeConfig(), makeTokenManager());
      await executor.run("test prompt", "myvol:/workspace", "/workspace", "task-2");

      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args).toContain("--cpus=0.4");
      expect(args).toContain("myvol:/workspace");
      expect(args).toContain("/workspace");
    });

    it("passes model flag when configured", async () => {
      spawnMock.mockReturnValue(makeFakeProc(0));

      const executor = new Executor(makeConfig({ model: "opus" }), makeTokenManager());
      await executor.run("test prompt", "vol:/workspace", "/workspace", "task-3");

      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args).toContain("--model");
      expect(args).toContain("opus");
    });

    it("returns exit code and captured output", async () => {
      const proc = makeFakeProc(0, false);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      const resultPromise = executor.run("test", "vol:/ws", "/ws", "task-4");

      // Wait a tick for the async getCredentials + spawn to complete
      await new Promise((r) => setTimeout(r, 5));

      // Simulate output
      proc.stdout!.emit("data", Buffer.from("hello "));
      proc.stderr!.emit("data", Buffer.from("world"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("hello world");
    });

    it("rejects when docker fails to start", async () => {
      const proc = new EventEmitter() as child_process.ChildProcess;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      Object.assign(proc, { stdout, stderr, stdin: null, stdio: [null, stdout, stderr], pid: 123, kill: vi.fn() });
      setTimeout(() => proc.emit("error", new Error("docker not found")), 10);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      await expect(executor.run("test", "vol:/ws", "/ws", "task-5")).rejects.toThrow(
        "Failed to start Docker container",
      );
    });

    it("uses sandbox image from SANDBOX_IMAGE env var", async () => {
      process.env.SANDBOX_IMAGE = "custom-sandbox-img";
      spawnMock.mockReturnValue(makeFakeProc(0));

      const executor = new Executor(makeConfig(), makeTokenManager());
      await executor.run("test", "vol:/ws", "/ws", "task-6");

      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args).toContain("custom-sandbox-img");
    });
  });

  describe("generateBranchSlug", () => {
    it("does NOT pass --privileged for slug generation (lightweight call)", async () => {
      const proc = makeFakeProc(0, false);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      const promise = executor.generateBranchSlug("Add login page", "slug-1");

      // Wait a tick for the async getCredentials + spawn to complete
      await new Promise((r) => setTimeout(r, 5));

      proc.stdout!.emit("data", Buffer.from("add-login-page"));
      proc.emit("close", 0);

      const slug = await promise;
      expect(slug).toBe("add-login-page");

      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args).not.toContain("--privileged");
    });
  });

  describe("generateTaskMetadata", () => {
    it("parses slug from line 1 and title from line 2", async () => {
      const proc = makeFakeProc(0, false);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      const promise = executor.generateTaskMetadata("Add dark mode toggle", "meta-1");

      await new Promise((r) => setTimeout(r, 5));
      proc.stdout!.emit("data", Buffer.from("add-dark-mode-toggle\nAdd Dark Mode Toggle"));
      proc.emit("close", 0);

      const { slug, title } = await promise;
      expect(slug).toBe("add-dark-mode-toggle");
      expect(title).toBe("Add Dark Mode Toggle");
    });

    it("sanitises slug to lowercase hyphens", async () => {
      const proc = makeFakeProc(0, false);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      const promise = executor.generateTaskMetadata("Some task", "meta-2");

      await new Promise((r) => setTimeout(r, 5));
      proc.stdout!.emit("data", Buffer.from("Add_Feature_123\nAdd Feature 123"));
      proc.emit("close", 0);

      const { slug } = await promise;
      expect(slug).toBe("add-feature-123");
    });

    it("uses haiku model and single container (no --privileged)", async () => {
      const proc = makeFakeProc(0, false);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      const promise = executor.generateTaskMetadata("Some task", "meta-3");

      await new Promise((r) => setTimeout(r, 5));
      proc.stdout!.emit("data", Buffer.from("some-task\nSome Task"));
      proc.emit("close", 0);
      await promise;

      // Exactly ONE container spawned
      expect(spawnMock).toHaveBeenCalledOnce();
      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args).not.toContain("--privileged");
      expect(args).toContain("haiku");
    });

    it("returns fallback slug and empty title on non-zero exit", async () => {
      const proc = makeFakeProc(1, false);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      const promise = executor.generateTaskMetadata("Some task", "meta-4");

      await new Promise((r) => setTimeout(r, 5));
      proc.emit("close", 1);

      const { slug, title } = await promise;
      expect(slug).toBe("task");
      expect(title).toBe("");
    });

    it("returns fallback on spawn error", async () => {
      const proc = new EventEmitter() as child_process.ChildProcess;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      Object.assign(proc, { stdout, stderr, stdin: null, stdio: [null, stdout, stderr], pid: 123, kill: vi.fn() });
      setTimeout(() => proc.emit("error", new Error("docker not found")), 10);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      const { slug, title } = await executor.generateTaskMetadata("Some task", "meta-5");
      expect(slug).toBe("task");
      expect(title).toBe("");
    });

    it("truncates slug to 40 chars and title to 60 chars", async () => {
      const proc = makeFakeProc(0, false);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      const promise = executor.generateTaskMetadata("Some task", "meta-6");

      await new Promise((r) => setTimeout(r, 5));
      proc.stdout!.emit("data", Buffer.from(`${"a".repeat(60)}\n${"B".repeat(80)}`));
      proc.emit("close", 0);

      const { slug, title } = await promise;
      expect(slug.length).toBeLessThanOrEqual(40);
      expect(title).toHaveLength(60);
    });
  });

  describe("generateTitle", () => {
    it("returns trimmed title from docker output", async () => {
      const proc = makeFakeProc(0, false);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      const promise = executor.generateTitle("Add dark mode toggle to the navbar", "title-1");

      await new Promise((r) => setTimeout(r, 5));

      proc.stdout!.emit("data", Buffer.from("  Add Dark Mode Toggle  "));
      proc.emit("close", 0);

      const title = await promise;
      expect(title).toBe("Add Dark Mode Toggle");
    });

    it("uses haiku model and no --privileged flag", async () => {
      const proc = makeFakeProc(0, false);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      const promise = executor.generateTitle("Some task", "title-2");

      await new Promise((r) => setTimeout(r, 5));
      proc.stdout!.emit("data", Buffer.from("Some Task"));
      proc.emit("close", 0);

      await promise;

      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args).not.toContain("--privileged");
      expect(args).toContain("haiku");
    });

    it("returns empty string on non-zero exit code", async () => {
      const proc = makeFakeProc(1, false);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      const promise = executor.generateTitle("Some task", "title-3");

      await new Promise((r) => setTimeout(r, 5));
      proc.emit("close", 1);

      const title = await promise;
      expect(title).toBe("");
    });

    it("returns empty string on spawn error", async () => {
      const proc = new EventEmitter() as child_process.ChildProcess;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      Object.assign(proc, { stdout, stderr, stdin: null, stdio: [null, stdout, stderr], pid: 123, kill: vi.fn() });
      setTimeout(() => proc.emit("error", new Error("docker not found")), 10);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      const title = await executor.generateTitle("Some task", "title-4");
      expect(title).toBe("");
    });

    it("truncates title to 60 characters", async () => {
      const proc = makeFakeProc(0, false);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      const promise = executor.generateTitle("Some very long task description here", "title-5");

      await new Promise((r) => setTimeout(r, 5));
      const longTitle = "A".repeat(80);
      proc.stdout!.emit("data", Buffer.from(longTitle));
      proc.emit("close", 0);

      const title = await promise;
      expect(title).toHaveLength(60);
    });
  });

  describe("container name uniqueness", () => {
    it("different Executor instances use different container names for the same taskId", async () => {
      spawnMock.mockReturnValue(makeFakeProc(0));

      const executor1 = new Executor(makeConfig(), makeTokenManager());
      const executor2 = new Executor(makeConfig(), makeTokenManager());

      await executor1.run("test", "vol:/ws", "/ws", "same-task");
      spawnMock.mockReturnValue(makeFakeProc(0));
      await executor2.run("test", "vol:/ws", "/ws", "same-task");

      const name1 = (spawnMock.mock.calls[0][1] as string[])[
        (spawnMock.mock.calls[0][1] as string[]).indexOf("--name") + 1
      ];
      const name2 = (spawnMock.mock.calls[1][1] as string[])[
        (spawnMock.mock.calls[1][1] as string[]).indexOf("--name") + 1
      ];

      expect(name1).not.toBe(name2);
    });
  });

  describe("kill", () => {
    it("sends SIGTERM to running process", async () => {
      const proc = makeFakeProc(0, false);
      spawnMock.mockReturnValue(proc);

      const executor = new Executor(makeConfig(), makeTokenManager());
      // Start but don't await - process is "running"
      const runPromise = executor.run("test", "vol:/ws", "/ws", "task-kill");

      // Wait for async getCredentials + spawn to set this.process
      await new Promise((r) => setTimeout(r, 5));

      executor.kill();
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

      // Clean up - close the process
      proc.emit("close", 1);
      await runPromise;
    });
  });
});
