import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PersistedTask, Branch } from "../src/types.js";
import type { Config } from "../src/config/config.js";
import { Project } from "../src/config/project.js";
import type { ProjectConfig } from "../src/config/config-types.js";
import { TaskStore } from "../src/task-store.js";

const TMP = join(import.meta.dirname, "..", "tmp", "dynamic-repo-test");
const DEFAULT_PROJECT_ID = "default";

function makeDefaultConfig(projectOverrides: Partial<ProjectConfig> = {}): Config {
  const serverConfig = {
    workspaceDir: TMP,
    maxConcurrentTasks: 3,
    metaCpus: 0.4,
    sandboxCpus: 0.4,
  };

  const projectConfigs: Record<string, any> = {
    [DEFAULT_PROJECT_ID]: {
      // Template project — no repositories
      repositories: [],
      claudeCode: { command: "claude" },
      apiKey: "default-api-key",
      ...projectOverrides,
    },
  };

  const config = {
    server: serverConfig,
    projects: {} as Record<string, Project>,
    configPath: join(TMP, "config.yaml"),
  } as Config;

  for (const [key, value] of Object.entries(projectConfigs)) {
    config.projects[key as any] = new Project(value as ProjectConfig, key as any, config);
  }

  return config;
}

/** Config with both a "default" (template) and a regular project. */
function makeMixedConfig(): Config {
  const serverConfig = {
    workspaceDir: TMP,
    maxConcurrentTasks: 3,
    metaCpus: 0.4,
    sandboxCpus: 0.4,
  };

  const projectConfigs: Record<string, any> = {
    [DEFAULT_PROJECT_ID]: {
      repositories: [],
      claudeCode: { command: "claude" },
      apiKey: "default-api-key",
    },
    "preconfigured": {
      repositories: [
        { name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" },
      ],
      claudeCode: { command: "claude" },
      apiKey: "preconfigured-api-key",
    },
  };

  const config = {
    server: serverConfig,
    projects: {} as Record<string, Project>,
    configPath: join(TMP, "config.yaml"),
  } as Config;

  for (const [key, value] of Object.entries(projectConfigs)) {
    config.projects[key as any] = new Project(value as ProjectConfig, key as any, config);
  }

  return config;
}

function makeBranch(name: string): Branch {
  return { name, createdAt: "2025-01-01T00:00:00.000Z" };
}

function makePersistedTask(overrides: Partial<any> = {}): PersistedTask {
  const branch =
    overrides.branch === null || overrides.branch === undefined
      ? undefined
      : typeof overrides.branch === "string"
        ? makeBranch(overrides.branch)
        : overrides.branch;

  return {
    taskId: "abc123",
    projectId: DEFAULT_PROJECT_ID,
    branch,
    prompt: "Add a button",
    status: "completed",
    createdAt: "2025-01-01T00:00:00.000Z",
    completedAt: "2025-01-01T01:00:00.000Z",
    output: "Done",
    workspaceId: 0,
    attempt: 1,
    chainId: "chain-abc123",
    ...overrides,
    ...(overrides.branch !== undefined ? { branch } : {}),
  } as any;
}

describe("Dynamic repository support", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(TMP, { recursive: true, force: true });
  });

  describe("createNewTask with repoUrl", () => {
    it("creates a task with dynamic repo on a template project", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test-slug",
        title: "Test Task",
        estimatedDurationSeconds: 300,
      });
      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask(DEFAULT_PROJECT_ID as any, {
        prompt: "Fix the bug",
        repoUrl: "https://github.com/test/dynamic-repo.git",
        githubToken: "ghp_dynamic_token_123",
      });

      expect(task.data.status).toBe("queued");
      expect(task.data.repoUrl).toBe("https://github.com/test/dynamic-repo.git");
      expect(task.data.githubToken).toBe("ghp_dynamic_token_123");
    });

    it("rejects repoUrl on a project with preconfigured repositories", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeMixedConfig();
      const tm = new TaskManager(config);

      expect(() =>
        tm.createNewTask("preconfigured" as any, {
          prompt: "Fix the bug",
          repoUrl: "https://github.com/test/dynamic-repo.git",
        })
      ).toThrow("Cannot use repoUrl with a project that has preconfigured repositories");
    });

    it("rejects task on template project without repoUrl", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const config = makeDefaultConfig();
      const tm = new TaskManager(config);

      expect(() =>
        tm.createNewTask(DEFAULT_PROJECT_ID as any, {
          prompt: "Fix the bug",
        })
      ).toThrow("Provide a repoUrl in the request body");
    });
  });

  describe("Task helper methods", () => {
    it("getRepositories returns dynamic repo config for dynamic tasks", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test-slug",
        title: "Test Task",
        estimatedDurationSeconds: 300,
      });
      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask(DEFAULT_PROJECT_ID as any, {
        prompt: "Fix the bug",
        repoUrl: "https://github.com/test/dynamic-repo.git",
        githubToken: "ghp_test",
      });

      const repos = task.getRepositories();
      expect(repos).toHaveLength(1);
      expect(repos[0].name).toBe("dynamic-repo");
      expect(repos[0].url).toBe("https://github.com/test/dynamic-repo.git");
      expect(repos[0].defaultBranch).toBe("main");
    });

    it("getGithubToken returns task-level token for dynamic tasks", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test-slug",
        title: "Test Task",
        estimatedDurationSeconds: 300,
      });
      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask(DEFAULT_PROJECT_ID as any, {
        prompt: "Fix the bug",
        repoUrl: "https://github.com/test/dynamic-repo.git",
        githubToken: "ghp_dynamic_token",
      });

      expect(task.getGithubToken()).toBe("ghp_dynamic_token");
    });

    it("getGithubToken falls back to project auth for non-dynamic tasks", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeMixedConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test-slug",
        title: "Test Task",
        estimatedDurationSeconds: 300,
      });
      const project = tm.config.projects["preconfigured" as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask("preconfigured" as any, {
        prompt: "Fix the bug",
      });

      // No task-level token, no project auth → undefined
      expect(task.getGithubToken()).toBeUndefined();
    });

    it("isDynamic returns true for tasks with repoUrl", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test-slug",
        title: "Test Task",
        estimatedDurationSeconds: 300,
      });
      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask(DEFAULT_PROJECT_ID as any, {
        prompt: "Fix the bug",
        repoUrl: "https://github.com/test/dynamic-repo.git",
      });

      expect(task.isDynamic).toBe(true);
    });

    it("getRepositories strips .git suffix from repo name", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig();
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test-slug",
        title: "Test Task",
        estimatedDurationSeconds: 300,
      });
      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask(DEFAULT_PROJECT_ID as any, {
        prompt: "Fix the bug",
        repoUrl: "https://github.com/org/my-project.git",
      });

      const repos = task.getRepositories();
      expect(repos[0].name).toBe("my-project");
    });
  });

  describe("chain continuation with dynamic repos", () => {
    it("inherits repoUrl and githubToken from parent task", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig();
      const store = new TaskStore(TMP);

      // Parent task with dynamic repo
      store.save(
        makePersistedTask({
          taskId: "parent-task",
          status: "completed",
          branch: "impl/feature-parent-task",
          chainId: "chain-parent",
          repoUrl: "https://github.com/test/dynamic-repo.git",
          githubToken: "ghp_parent_token",
        })
      );

      const tm = new TaskManager(config);
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test",
        title: "Test",
        estimatedDurationSeconds: 600,
      });

      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      await tm.init();

      const task = tm.createNewTask(DEFAULT_PROJECT_ID as any, {
        prompt: "Continue work",
        continueTaskId: "parent-task" as any,
      });

      expect(task.data.repoUrl).toBe("https://github.com/test/dynamic-repo.git");
      expect(task.data.githubToken).toBe("ghp_parent_token");
      expect(task.branch?.name).toBe("impl/feature-parent-task");
    });

    it("allows overriding githubToken in continuation", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig();
      const store = new TaskStore(TMP);

      store.save(
        makePersistedTask({
          taskId: "parent-task",
          status: "completed",
          branch: "impl/feature-parent-task",
          chainId: "chain-parent",
          repoUrl: "https://github.com/test/dynamic-repo.git",
          githubToken: "ghp_old_token",
        })
      );

      const tm = new TaskManager(config);
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test",
        title: "Test",
        estimatedDurationSeconds: 600,
      });

      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      await tm.init();

      const task = tm.createNewTask(DEFAULT_PROJECT_ID as any, {
        prompt: "Continue work",
        continueTaskId: "parent-task" as any,
        githubToken: "ghp_new_token",
      });

      // Request-level token takes precedence over inherited
      expect(task.data.githubToken).toBe("ghp_new_token");
      // repoUrl still inherited
      expect(task.data.repoUrl).toBe("https://github.com/test/dynamic-repo.git");
    });

    it("allows continuation on template project without explicit repoUrl (inherits from parent)", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig();
      const store = new TaskStore(TMP);

      store.save(
        makePersistedTask({
          taskId: "parent-dynamic",
          status: "completed",
          branch: "impl/dyn-parent",
          chainId: "chain-dyn",
          repoUrl: "https://github.com/test/repo.git",
          githubToken: "ghp_token",
        })
      );

      const tm = new TaskManager(config);
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test",
        title: "Test",
        estimatedDurationSeconds: 600,
      });

      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      await tm.init();

      // Should not throw — repoUrl is inherited from parent
      const task = tm.createNewTask(DEFAULT_PROJECT_ID as any, {
        prompt: "Continue",
        continueTaskId: "parent-dynamic" as any,
      });

      expect(task.data.repoUrl).toBe("https://github.com/test/repo.git");
    });
  });

  describe("retry preserves dynamic repo credentials", () => {
    it("preserves githubToken and repoUrl after manual retry", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig();
      const store = new TaskStore(TMP);

      // Create a completed dynamic task with a custom githubToken
      store.save(
        makePersistedTask({
          taskId: "retry-token-task",
          status: "failed",
          completedAt: "2025-01-01T01:00:00.000Z",
          branch: "impl/retry-test",
          chainId: "chain-retry",
          repoUrl: "https://github.com/other-account/private-repo.git",
          githubToken: "ghp_custom_token_from_user",
          attempt: 1,
        })
      );

      const tm = new TaskManager(config);
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test",
        title: "Test",
        estimatedDurationSeconds: 600,
      });

      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // Retry the task
      const retried = tm.retryTask(DEFAULT_PROJECT_ID as any, "retry-token-task" as any);

      // Token and repoUrl must be preserved after retry
      expect(retried.data.githubToken).toBe("ghp_custom_token_from_user");
      expect(retried.data.repoUrl).toBe("https://github.com/other-account/private-repo.git");
      expect(retried.getGithubToken()).toBe("ghp_custom_token_from_user");
      expect(retried.isDynamic).toBe(true);
      expect(retried.data.status).toBe("queued");
      expect(retried.data.attempt).toBe(2);
    });

    it("preserves githubToken after automatic errorRetry", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig({
        errorRetry: { maxAttempts: 3, delaySeconds: 0 },
      });
      const store = new TaskStore(TMP);

      // Create a retrying dynamic task (auto-retry from errorRetry)
      store.save(
        makePersistedTask({
          taskId: "auto-retry-task",
          status: "retrying",
          completedAt: null,
          branch: "impl/auto-retry-test",
          chainId: "chain-auto-retry",
          repoUrl: "https://github.com/other-account/private-repo.git",
          githubToken: "ghp_auto_retry_token",
          attempt: 1,
          nextRetryAt: new Date(Date.now() - 1000).toISOString(), // already elapsed
        })
      );

      const tm = new TaskManager(config);
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test",
        title: "Test",
        estimatedDurationSeconds: 600,
      });

      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // The dequeueAvailableTasks() in init() should have promoted the retrying task
      const task = tm.getTask("auto-retry-task" as any);
      expect(task).toBeDefined();
      // Token and repoUrl must still be present
      expect(task!.data.githubToken).toBe("ghp_auto_retry_token");
      expect(task!.data.repoUrl).toBe("https://github.com/other-account/private-repo.git");
      expect(task!.getGithubToken()).toBe("ghp_auto_retry_token");
    });

    it("preserves githubToken in persisted JSON after retry", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig();
      const store = new TaskStore(TMP);

      store.save(
        makePersistedTask({
          taskId: "persist-retry-task",
          status: "failed",
          completedAt: "2025-01-01T01:00:00.000Z",
          branch: "impl/persist-retry",
          chainId: "chain-persist-retry",
          repoUrl: "https://github.com/org/repo.git",
          githubToken: "ghp_persist_test",
          attempt: 1,
        })
      );

      const tm = new TaskManager(config);
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test",
        title: "Test",
        estimatedDurationSeconds: 600,
      });

      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      // Retry the task
      tm.retryTask(DEFAULT_PROJECT_ID as any, "persist-retry-task" as any);

      // Simulate restart — verify token is persisted to disk
      const config2 = makeDefaultConfig();
      const tm2 = new TaskManager(config2);
      const project2 = tm2.config.projects[DEFAULT_PROJECT_ID as any];
      project2.initialize();
      vi.spyOn(project2, "initialize").mockImplementation(() => {});
      vi.spyOn(project2.pool, "hasFreeSlot").mockReturnValue(false);

      await tm2.init();

      const restored = tm2.getTask("persist-retry-task" as any);
      expect(restored).toBeDefined();
      expect(restored!.data.githubToken).toBe("ghp_persist_test");
      expect(restored!.data.repoUrl).toBe("https://github.com/org/repo.git");
    });
  });

  describe("config schema allows empty repositories", () => {
    it("accepts a project with empty repositories array", async () => {
      const { ConfigSchema } = await import("../src/config/config-types.js");

      const result = ConfigSchema.safeParse({
        server: { workspaceDir: "/tmp/test" },
        projects: {
          default: {
            repositories: [],
            claudeCode: { command: "claude" },
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it("accepts a project with no repositories field (defaults to empty)", async () => {
      const { ConfigSchema } = await import("../src/config/config-types.js");

      const result = ConfigSchema.safeParse({
        server: { workspaceDir: "/tmp/test" },
        projects: {
          default: {
            claudeCode: { command: "claude" },
          },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.projects.default.repositories).toEqual([]);
      }
    });
  });

  describe("project-level auth.githubToken resolution", () => {
    it("resolves project auth.githubToken at task creation when no request token provided", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig({
        auth: { githubToken: "ghp_project_level_token" },
      });
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test-slug",
        title: "Test Task",
        estimatedDurationSeconds: 300,
      });
      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask(DEFAULT_PROJECT_ID as any, {
        prompt: "Fix the bug",
        repoUrl: "https://github.com/test/repo.git",
      });

      // Token should be resolved from project auth and stored on task data
      expect(task.data.githubToken).toBe("ghp_project_level_token");
      expect(task.getGithubToken()).toBe("ghp_project_level_token");
    });

    it("request-level githubToken overrides project auth.githubToken", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig({
        auth: { githubToken: "ghp_project_level_token" },
      });
      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test-slug",
        title: "Test Task",
        estimatedDurationSeconds: 300,
      });
      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask(DEFAULT_PROJECT_ID as any, {
        prompt: "Fix the bug",
        repoUrl: "https://github.com/test/repo.git",
        githubToken: "ghp_request_override_token",
      });

      // Request-level token should take precedence
      expect(task.data.githubToken).toBe("ghp_request_override_token");
      expect(task.getGithubToken()).toBe("ghp_request_override_token");
    });

    it("preserves project-resolved githubToken after manual retry", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig({
        auth: { githubToken: "ghp_project_level_token" },
      });
      const store = new TaskStore(TMP);

      // Create a failed task whose githubToken was resolved from project auth
      store.save(
        makePersistedTask({
          taskId: "project-token-retry",
          status: "failed",
          completedAt: "2025-01-01T01:00:00.000Z",
          branch: "impl/retry-project-token",
          chainId: "chain-pt-retry",
          repoUrl: "https://github.com/org/repo.git",
          githubToken: "ghp_project_level_token",
          attempt: 1,
        })
      );

      const tm = new TaskManager(config);
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test",
        title: "Test",
        estimatedDurationSeconds: 600,
      });

      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      await tm.init();

      const retried = tm.retryTask(DEFAULT_PROJECT_ID as any, "project-token-retry" as any);

      expect(retried.data.githubToken).toBe("ghp_project_level_token");
      expect(retried.getGithubToken()).toBe("ghp_project_level_token");
      expect(retried.data.status).toBe("queued");
      expect(retried.data.attempt).toBe(2);
    });

    it("chain continuation inherits resolved project token from parent", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig({
        auth: { githubToken: "ghp_project_level_token" },
      });
      const store = new TaskStore(TMP);

      // Parent task whose token was resolved from project auth
      store.save(
        makePersistedTask({
          taskId: "parent-project-token",
          status: "completed",
          branch: "impl/feature-pt",
          chainId: "chain-pt",
          repoUrl: "https://github.com/org/repo.git",
          githubToken: "ghp_project_level_token",
        })
      );

      const tm = new TaskManager(config);
      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test",
        title: "Test",
        estimatedDurationSeconds: 600,
      });

      const project = tm.config.projects[DEFAULT_PROJECT_ID as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "acquire").mockRejectedValue(new Error("no capacity"));

      await tm.init();

      const child = tm.createNewTask(DEFAULT_PROJECT_ID as any, {
        prompt: "Continue work",
        continueTaskId: "parent-project-token" as any,
      });

      // Child should inherit parent's resolved token
      expect(child.data.githubToken).toBe("ghp_project_level_token");
      expect(child.getGithubToken()).toBe("ghp_project_level_token");
    });

    it("preserves resolved project token across persistence and restart", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig({
        auth: { githubToken: "ghp_project_level_token" },
      });

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test-slug",
        title: "Test Task",
        estimatedDurationSeconds: 300,
      });

      const tm1 = new TaskManager(config);
      const project1 = tm1.config.projects[DEFAULT_PROJECT_ID as any];
      project1.initialize();
      vi.spyOn(project1, "initialize").mockImplementation(() => {});
      vi.spyOn(project1.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm1.createNewTask(DEFAULT_PROJECT_ID as any, {
        prompt: "Dynamic task with project token",
        repoUrl: "https://github.com/test/repo.git",
      });

      expect(task.data.githubToken).toBe("ghp_project_level_token");

      // Simulate restart
      const config2 = makeDefaultConfig({
        auth: { githubToken: "ghp_project_level_token" },
      });
      const tm2 = new TaskManager(config2);
      const project2 = tm2.config.projects[DEFAULT_PROJECT_ID as any];
      project2.initialize();
      vi.spyOn(project2, "initialize").mockImplementation(() => {});
      vi.spyOn(project2.pool, "hasFreeSlot").mockReturnValue(false);

      await tm2.init();

      const restored = tm2.getTask(task.id);
      expect(restored).toBeDefined();
      expect(restored!.data.githubToken).toBe("ghp_project_level_token");
      expect(restored!.getGithubToken()).toBe("ghp_project_level_token");
    });

    it("project with preconfigured repos resolves auth.githubToken at task creation", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");

      const serverConfig = {
        workspaceDir: TMP,
        maxConcurrentTasks: 3,
        metaCpus: 0.4,
        sandboxCpus: 0.4,
      };

      const config = {
        server: serverConfig,
        projects: {} as Record<string, Project>,
        configPath: join(TMP, "config.yaml"),
      } as Config;

      config.projects["myproject" as any] = new Project(
        {
          repositories: [
            { name: "my-repo", url: "https://github.com/org/my-repo.git", defaultBranch: "main" },
          ],
          claudeCode: { command: "claude" },
          apiKey: "myproject-key",
          auth: { githubToken: "ghp_preconfigured_token" },
        } as ProjectConfig,
        "myproject" as any,
        config
      );

      const tm = new TaskManager(config);

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test-slug",
        title: "Test",
        estimatedDurationSeconds: 300,
      });
      const project = tm.config.projects["myproject" as any];
      project.initialize();
      vi.spyOn(project, "initialize").mockImplementation(() => {});
      vi.spyOn(project.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm.createNewTask("myproject" as any, {
        prompt: "Fix the bug",
      });

      // Token should be resolved from project auth even for preconfigured repos
      expect(task.data.githubToken).toBe("ghp_preconfigured_token");
      expect(task.getGithubToken()).toBe("ghp_preconfigured_token");
    });
  });

  describe("persistence", () => {
    it("persists and restores dynamic repo fields across restart", async () => {
      const { TaskManager } = await import("../src/task-manager/task-manager.js");
      const { Executor } = await import("../src/executor.js");
      const config = makeDefaultConfig();

      vi.spyOn(Executor.prototype, "generateTaskMetadata").mockResolvedValue({
        slug: "test-slug",
        title: "Test Task",
        estimatedDurationSeconds: 300,
      });

      // Create and persist a dynamic task
      const tm1 = new TaskManager(config);
      const project1 = tm1.config.projects[DEFAULT_PROJECT_ID as any];
      project1.initialize();
      vi.spyOn(project1, "initialize").mockImplementation(() => {});
      vi.spyOn(project1.pool, "hasFreeSlot").mockReturnValue(false);

      const task = tm1.createNewTask(DEFAULT_PROJECT_ID as any, {
        prompt: "Dynamic task",
        repoUrl: "https://github.com/test/persisted-repo.git",
        githubToken: "ghp_persisted_token",
      });

      const taskId = task.id;

      // Simulate restart — create new TaskManager, load from disk
      const config2 = makeDefaultConfig();
      const tm2 = new TaskManager(config2);
      const project2 = tm2.config.projects[DEFAULT_PROJECT_ID as any];
      project2.initialize();
      vi.spyOn(project2, "initialize").mockImplementation(() => {});
      vi.spyOn(project2.pool, "hasFreeSlot").mockReturnValue(false);

      await tm2.init();

      const restored = tm2.getTask(taskId);
      expect(restored).toBeDefined();
      expect(restored!.data.repoUrl).toBe("https://github.com/test/persisted-repo.git");
      expect(restored!.data.githubToken).toBe("ghp_persisted_token");
      expect(restored!.isDynamic).toBe(true);

      const repos = restored!.getRepositories();
      expect(repos).toHaveLength(1);
      expect(repos[0].name).toBe("persisted-repo");
    });
  });
});
