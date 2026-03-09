import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Config } from "../src/config/config.js";

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

describe("Config.load", () => {
    it("loads a minimal valid config", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: my-repo
        url: https://github.com/test/repo.git
`
        );

        const config = Config.load(path);

        expect(config.server.workspaceDir).toContain("tmp");
        expect(Object.keys(config.projects)).toHaveLength(1);
        const project = config.projects["my-project"];
        expect(project.data.repositories).toHaveLength(1);
        expect(project.data.repositories[0].name).toBe("my-repo");
        expect(project.data.repositories[0].defaultBranch).toBe("main");
        expect(project.data.claudeCode.command).toBe("claude");
    });


    it("defaults timeoutSeconds to 3600 when not specified", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: my-repo
        url: https://github.com/test/repo.git
`
        );

        const config = Config.load(path);
        expect(config.projects["my-project"].data.claudeCode.timeoutSeconds).toBe(3600);
    });

    it("respects explicit timeoutSeconds when provided", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: my-repo
        url: https://github.com/test/repo.git
    claudeCode:
      timeoutSeconds: 600
`
        );

        const config = Config.load(path);
        expect(config.projects["my-project"].data.claudeCode.timeoutSeconds).toBe(600);
    });

    it("rejects timeoutSeconds below 60", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: my-repo
        url: https://github.com/test/repo.git
    claudeCode:
      timeoutSeconds: 30
`
        );

        expect(() => Config.load(path)).toThrow();
    });

    it("loads maxConcurrentTasks per project", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    maxConcurrentTasks: 8
    repositories:
      - name: my-repo
        url: https://github.com/test/repo.git
`
        );

        const config = Config.load(path);
        expect(config.projects["my-project"].data.maxConcurrentTasks).toBe(8);
    });

    it("rejects maxConcurrentTasks less than 1", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    maxConcurrentTasks: 0
    repositories:
      - name: my-repo
        url: https://github.com/test/repo.git
`
        );

        expect(() => Config.load(path)).toThrow();
    });

    it("loads server-level maxConcurrentTasks", () => {
        const path = writeYaml(
            "config.yaml",
            `
server:
  maxConcurrentTasks: 5
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
`
        );

        const config = Config.load(path);
        expect(config.server.maxConcurrentTasks).toBe(5);
    });

    it("rejects server.maxConcurrentTasks less than 1", () => {
        const path = writeYaml(
            "config.yaml",
            `
server:
  maxConcurrentTasks: 0
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
`
        );

        expect(() => Config.load(path)).toThrow();
    });

    it("loads a full config with all fields", () => {
        const path = writeYaml(
            "config.yaml",
            `
server:
  workspaceDir: ./workspaces

projects:
  webapp:
    apiKey: secret-key
    maxConcurrentTasks: 2
    repositories:
      - name: frontend
        url: https://github.com/test/frontend.git
        defaultBranch: develop
      - name: backend
        url: https://github.com/test/backend.git
    claudeCode:
      command: claude-dev
      model: opus
      systemPrompt: "Always write tests."
      mcpServers:
        playwright:
          command: npx
          args: ["@playwright/mcp@latest", "--headless"]
    auth:
      anthropicApiKey: sk-test-key
      githubToken: ghp-test-token
`
        );

        const config = Config.load(path);

        const project = config.projects["webapp"];
        expect(project.data.repositories).toHaveLength(2);
        expect(project.data.repositories[0].defaultBranch).toBe("develop");
        expect(project.data.repositories[1].defaultBranch).toBe("main");
        expect(project.data.claudeCode.command).toBe("claude-dev");
        expect(project.data.claudeCode.model).toBe("opus");
        expect(project.data.claudeCode.systemPrompt).toBe("Always write tests.");
        expect(project.data.claudeCode.mcpServers?.playwright.command).toBe("npx");
        expect(project.data.claudeCode.mcpServers?.playwright.args).toEqual([
            "@playwright/mcp@latest",
            "--headless"
        ]);
        expect(project.data.apiKey).toBe("secret-key");
        expect(project.data.maxConcurrentTasks).toBe(2);
        expect(project.data.auth?.anthropicApiKey).toBe("sk-test-key");
        expect(project.data.auth?.githubToken).toBe("ghp-test-token");
    });

    it("supports multiple projects", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  project-a:
    repositories:
      - name: repo-a
        url: https://github.com/test/repo-a.git
  project-b:
    repositories:
      - name: repo-b
        url: https://github.com/test/repo-b.git
`
        );

        const config = Config.load(path);
        expect(Object.keys(config.projects)).toHaveLength(2);
        expect(config.projects["project-a"].data.repositories[0].name).toBe(
            "repo-a"
        );
        expect(config.projects["project-b"].data.repositories[0].name).toBe(
            "repo-b"
        );
    });

    it("rejects config with no projects", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects: {}
`
        );

        expect(() => Config.load(path)).toThrow();
    });

    it("rejects project with no repositories", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories: []
`
        );

        expect(() => Config.load(path)).toThrow();
    });

    it("rejects project with missing repository name", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - url: https://github.com/test/repo.git
`
        );

        expect(() => Config.load(path)).toThrow();
    });

    it("rejects project with missing repository url", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: my-repo
`
        );

        expect(() => Config.load(path)).toThrow();
    });

    it("rejects unknown top-level fields", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
unknownField: true
`
        );

        expect(() => Config.load(path)).toThrow();
    });

    it("rejects unknown project fields", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
    unknownSetting: value
`
        );

        expect(() => Config.load(path)).toThrow();
    });

    it("resolves workspaceDir relative to config file", () => {
        const path = writeYaml(
            "config.yaml",
            `
server:
  workspaceDir: ./my-workspace
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
`
        );

        const config = Config.load(path);
        expect(config.server.workspaceDir).toBe(join(TMP, "my-workspace"));
    });

    it("loads protectedPaths when provided", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
    protectedPaths:
      - .github
      - Dockerfile
      - docker-compose.yml
`
        );

        const config = Config.load(path);
        expect(config.projects["my-project"].data.protectedPaths).toEqual([
            ".github",
            "Dockerfile",
            "docker-compose.yml"
        ]);
    });

    it("sets protectedPaths to undefined when not provided", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
`
        );

        const config = Config.load(path);
        expect(config.projects["my-project"].data.protectedPaths).toBeUndefined();
    });

    it("loads waitForPipeline: true when set", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
    waitForPipeline: true
`
        );

        const config = Config.load(path);
        expect(config.projects["my-project"].data.waitForPipeline).toBe(true);
    });

    it("loads waitForPipeline: false when explicitly set to false", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
    waitForPipeline: false
`
        );

        const config = Config.load(path);
        expect(config.projects["my-project"].data.waitForPipeline).toBe(false);
    });

    it("sets waitForPipeline to undefined when not provided", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
`
        );

        const config = Config.load(path);
        expect(config.projects["my-project"].data.waitForPipeline).toBeUndefined();
    });

});

describe("defaults merging", () => {
    it("concatenates global and project systemPrompt", () => {
        const path = writeYaml(
            "config.yaml",
            `
defaults:
  systemPrompt: "Global instructions."
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
    claudeCode:
      systemPrompt: "Project instructions."
`
        );

        const config = Config.load(path);
        expect(config.projects["my-project"].data.claudeCode.systemPrompt).toBe(
            "Global instructions.\nProject instructions."
        );
    });

    it("shallow-merges mcpServers with project overriding global", () => {
        const path = writeYaml(
            "config.yaml",
            `
defaults:
  mcpServers:
    playwright:
      command: npx
      args: ["@playwright/mcp@latest", "--headless"]
    shared-tool:
      command: shared
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
    claudeCode:
      mcpServers:
        playwright:
          command: custom-pw
        custom-tool:
          command: custom
`
        );

        const config = Config.load(path);
        const servers = config.projects["my-project"].data.claudeCode.mcpServers!;

        // Project overrides global key
        expect(servers["playwright"].command).toBe("custom-pw");
        expect(servers["playwright"].args).toBeUndefined();
        // Global-only key preserved
        expect(servers["shared-tool"].command).toBe("shared");
        // Project-only key preserved
        expect(servers["custom-tool"].command).toBe("custom");
    });

    it("applies defaults when project has no systemPrompt or mcpServers", () => {
        const path = writeYaml(
            "config.yaml",
            `
defaults:
  systemPrompt: "Global only."
  mcpServers:
    playwright:
      command: npx
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
`
        );

        const config = Config.load(path);
        const cc = config.projects["my-project"].data.claudeCode;
        expect(cc.systemPrompt).toBe("Global only.");
        expect(cc.mcpServers?.playwright.command).toBe("npx");
    });

    it("uses project values when no defaults section exists", () => {
        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
    claudeCode:
      systemPrompt: "Project only."
      mcpServers:
        tool:
          command: my-tool
`
        );

        const config = Config.load(path);
        const cc = config.projects["my-project"].data.claudeCode;
        expect(cc.systemPrompt).toBe("Project only.");
        expect(cc.mcpServers?.tool.command).toBe("my-tool");
    });

    it("handles defaults with only systemPrompt (no mcpServers)", () => {
        const path = writeYaml(
            "config.yaml",
            `
defaults:
  systemPrompt: "Global prompt."
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
    claudeCode:
      mcpServers:
        tool:
          command: my-tool
`
        );

        const config = Config.load(path);
        const cc = config.projects["my-project"].data.claudeCode;
        expect(cc.systemPrompt).toBe("Global prompt.");
        expect(cc.mcpServers?.tool.command).toBe("my-tool");
    });

    it("handles defaults with only mcpServers (no systemPrompt)", () => {
        const path = writeYaml(
            "config.yaml",
            `
defaults:
  mcpServers:
    global-tool:
      command: global
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
    claudeCode:
      systemPrompt: "Project only."
`
        );

        const config = Config.load(path);
        const cc = config.projects["my-project"].data.claudeCode;
        expect(cc.systemPrompt).toBe("Project only.");
        expect(cc.mcpServers?.["global-tool"].command).toBe("global");
    });

    it("applies defaults to all projects", () => {
        const path = writeYaml(
            "config.yaml",
            `
defaults:
  systemPrompt: "Shared."
  mcpServers:
    shared:
      command: shared-cmd
projects:
  project-a:
    repositories:
      - name: repo-a
        url: https://github.com/test/repo-a.git
  project-b:
    repositories:
      - name: repo-b
        url: https://github.com/test/repo-b.git
    claudeCode:
      systemPrompt: "B-specific."
`
        );

        const config = Config.load(path);

        const a = config.projects["project-a"].data.claudeCode;
        expect(a.systemPrompt).toBe("Shared.");
        expect(a.mcpServers?.shared.command).toBe("shared-cmd");

        const b = config.projects["project-b"].data.claudeCode;
        expect(b.systemPrompt).toBe("Shared.\nB-specific.");
        expect(b.mcpServers?.shared.command).toBe("shared-cmd");
    });
});
