import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";

const TMP = join(import.meta.dirname, "..", "tmp", "config-test");

function writeYaml(filename: string, content: string): string {
  const path = join(TMP, filename);
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads a minimal valid config", () => {
    const path = writeYaml(
      "config.yaml",
      `
repositories:
  - name: my-repo
    url: https://github.com/test/repo.git
`,
    );

    const config = loadConfig(path);

    expect(config.server.workspaceDir).toContain("tmp");
    expect(config.repositories).toHaveLength(1);
    expect(config.repositories[0].name).toBe("my-repo");
    expect(config.repositories[0].defaultBranch).toBe("main");
    expect(config.claudeCode.command).toBe("claude");
    expect(config.claudeCode.dockerImage).toBe("implementer-sandbox");
  });

  it("loads a full config with all fields", () => {
    const path = writeYaml(
      "config.yaml",
      `
server:
  workspaceDir: ./workspaces

repositories:
  - name: frontend
    url: https://github.com/test/frontend.git
    defaultBranch: develop
  - name: backend
    url: https://github.com/test/backend.git

claudeCode:
  command: claude-dev
  model: opus
  dockerImage: my-sandbox
  systemPrompt: "Always write tests."
  mcpServers:
    playwright:
      command: npx
      args: ["@playwright/mcp@latest", "--headless"]
`,
    );

    const config = loadConfig(path);

    expect(config.repositories).toHaveLength(2);
    expect(config.repositories[0].defaultBranch).toBe("develop");
    expect(config.repositories[1].defaultBranch).toBe("main");
    expect(config.claudeCode.command).toBe("claude-dev");
    expect(config.claudeCode.model).toBe("opus");
    expect(config.claudeCode.systemPrompt).toBe("Always write tests.");
    expect(config.claudeCode.mcpServers?.playwright.command).toBe("npx");
    expect(config.claudeCode.mcpServers?.playwright.args).toEqual([
      "@playwright/mcp@latest",
      "--headless",
    ]);
  });

  it("rejects config with no repositories", () => {
    const path = writeYaml(
      "config.yaml",
      `
repositories: []
`,
    );

    expect(() => loadConfig(path)).toThrow();
  });

  it("rejects config with missing repository name", () => {
    const path = writeYaml(
      "config.yaml",
      `
repositories:
  - url: https://github.com/test/repo.git
`,
    );

    expect(() => loadConfig(path)).toThrow();
  });

  it("rejects config with missing repository url", () => {
    const path = writeYaml(
      "config.yaml",
      `
repositories:
  - name: my-repo
`,
    );

    expect(() => loadConfig(path)).toThrow();
  });

  it("resolves workspaceDir relative to config file", () => {
    const path = writeYaml(
      "config.yaml",
      `
server:
  workspaceDir: ./my-workspace
repositories:
  - name: repo
    url: https://github.com/test/repo.git
`,
    );

    const config = loadConfig(path);
    expect(config.server.workspaceDir).toBe(join(TMP, "my-workspace"));
  });
});
