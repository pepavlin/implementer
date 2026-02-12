import { describe, it, expect } from "vitest";
import type { Config } from "./types.js";
import { TokenManager } from "./auth.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    server: { workspaceDir: "/tmp/workspace" },
    repositories: [
      { name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" },
    ],
    claudeCode: {
      command: "claude",
    },
    ...overrides,
  };
}

function makeTokenManager(): TokenManager {
  return new TokenManager("/tmp/workspace");
}

describe("TaskManager", () => {
  it("can be instantiated with valid config", async () => {
    const { TaskManager } = await import("./task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config, makeTokenManager());
    expect(tm).toBeDefined();
  });

  it("listTasks returns empty array initially", async () => {
    const { TaskManager } = await import("./task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config, makeTokenManager());
    expect(tm.listTasks()).toEqual([]);
  });

  it("getTask returns undefined for unknown id", async () => {
    const { TaskManager } = await import("./task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config, makeTokenManager());
    expect(tm.getTask("nonexistent")).toBeUndefined();
  });

  it("getOutput returns empty string for unknown id", async () => {
    const { TaskManager } = await import("./task-manager.js");
    const config = makeConfig();
    const tm = new TaskManager(config, makeTokenManager());
    expect(tm.getOutput("nonexistent")).toBe("");
  });

  it("accepts multiple repositories in config", async () => {
    const { TaskManager } = await import("./task-manager.js");
    const config = makeConfig({
      repositories: [
        { name: "frontend", url: "https://github.com/test/fe.git", defaultBranch: "main" },
        { name: "backend", url: "https://github.com/test/be.git", defaultBranch: "master" },
      ],
    });
    const tm = new TaskManager(config, makeTokenManager());
    expect(tm).toBeDefined();
  });

  it("accepts systemPrompt in config", async () => {
    const { TaskManager } = await import("./task-manager.js");
    const config = makeConfig({
      claudeCode: {
        command: "claude",
        systemPrompt: "Always write tests.",
      },
    });
    const tm = new TaskManager(config, makeTokenManager());
    expect(tm).toBeDefined();
  });
});
