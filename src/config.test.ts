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
projects:
  my-project:
    repositories:
      - name: my-repo
        url: https://github.com/test/repo.git
`
        );

        const config = loadConfig(path);

        expect(config.server.workspaceDir).toContain("tmp");
        expect(Object.keys(config.projects)).toHaveLength(1);
        const project = config.projects["my-project"];
        expect(project.repositories).toHaveLength(1);
        expect(project.repositories[0].name).toBe("my-repo");
        expect(project.repositories[0].defaultBranch).toBe("main");
        expect(project.claudeCode.command).toBe("claude");
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

        const config = loadConfig(path);
        expect(config.projects["my-project"].maxConcurrentTasks).toBe(8);
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

        expect(() => loadConfig(path)).toThrow();
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

        const config = loadConfig(path);
        expect(config.server.maxConcurrentTasks).toBe(5);
    });

    it("loads server-level maxTokensPerHour", () => {
        const path = writeYaml(
            "config.yaml",
            `
server:
  maxTokensPerHour: 200000
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
`
        );

        const config = loadConfig(path);
        expect(config.server.maxTokensPerHour).toBe(200_000);
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

        expect(() => loadConfig(path)).toThrow();
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

        const config = loadConfig(path);

        const project = config.projects["webapp"];
        expect(project.repositories).toHaveLength(2);
        expect(project.repositories[0].defaultBranch).toBe("develop");
        expect(project.repositories[1].defaultBranch).toBe("main");
        expect(project.claudeCode.command).toBe("claude-dev");
        expect(project.claudeCode.model).toBe("opus");
        expect(project.claudeCode.systemPrompt).toBe("Always write tests.");
        expect(project.claudeCode.mcpServers?.playwright.command).toBe("npx");
        expect(project.claudeCode.mcpServers?.playwright.args).toEqual([
            "@playwright/mcp@latest",
            "--headless"
        ]);
        expect(project.apiKey).toBe("secret-key");
        expect(project.maxConcurrentTasks).toBe(2);
        expect(project.auth?.anthropicApiKey).toBe("sk-test-key");
        expect(project.auth?.githubToken).toBe("ghp-test-token");
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

        const config = loadConfig(path);
        expect(Object.keys(config.projects)).toHaveLength(2);
        expect(config.projects["project-a"].repositories[0].name).toBe(
            "repo-a"
        );
        expect(config.projects["project-b"].repositories[0].name).toBe(
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

        expect(() => loadConfig(path)).toThrow();
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

        expect(() => loadConfig(path)).toThrow();
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

        expect(() => loadConfig(path)).toThrow();
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

        expect(() => loadConfig(path)).toThrow();
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

        expect(() => loadConfig(path)).toThrow();
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

        expect(() => loadConfig(path)).toThrow();
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

        const config = loadConfig(path);
        expect(config.server.workspaceDir).toBe(join(TMP, "my-workspace"));
    });

    it("interpolates ${VAR} references in auth fields", () => {
        process.env.TEST_ANTHROPIC_KEY = "sk-from-env";
        process.env.TEST_GITHUB_TOKEN = "ghp-from-env";

        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
    auth:
      anthropicApiKey: \${TEST_ANTHROPIC_KEY}
      githubToken: \${TEST_GITHUB_TOKEN}
`
        );

        const config = loadConfig(path);
        expect(config.projects["my-project"].auth?.anthropicApiKey).toBe(
            "sk-from-env"
        );
        expect(config.projects["my-project"].auth?.githubToken).toBe(
            "ghp-from-env"
        );

        delete process.env.TEST_ANTHROPIC_KEY;
        delete process.env.TEST_GITHUB_TOKEN;
    });

    it("interpolates ${VAR} references in apiKey field", () => {
        process.env.TEST_API_KEY = "my-api-key";

        const path = writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    apiKey: \${TEST_API_KEY}
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
`
        );

        const config = loadConfig(path);
        expect(config.projects["my-project"].apiKey).toBe("my-api-key");

        delete process.env.TEST_API_KEY;
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

        const config = loadConfig(path);
        expect(config.projects["my-project"].protectedPaths).toEqual([
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

        const config = loadConfig(path);
        expect(config.projects["my-project"].protectedPaths).toBeUndefined();
    });

    it("interpolates ${VAR} references in claudeOauthToken field", () => {
        process.env.TEST_CLAUDE_OAUTH_TOKEN = "oauth-from-env";

        const path = writeYaml(
            "config.yaml",
            `
    projects:
      my-project:
        repositories:
          - name: repo
            url: https://github.com/test/repo.git
        auth:
          claudeOauthToken: \${TEST_CLAUDE_OAUTH_TOKEN}
    `
        );

        const config = loadConfig(path);
        expect(config.projects["my-project"].auth?.claudeOauthToken).toBe(
            "oauth-from-env"
        );

        delete process.env.TEST_CLAUDE_OAUTH_TOKEN;
    });
});
