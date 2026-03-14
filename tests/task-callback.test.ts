import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PersistedTask, Branch } from "../src/types.js";
import type { Config } from "../src/config/config.js";
import { Project } from "../src/config/project.js";
import type { ProjectConfig } from "../src/config/config-types.js";
import { Task } from "../src/task-manager/task.js";
import { TaskManager } from "../src/task-manager/task-manager.js";

const TMP = join(import.meta.dirname, "..", "tmp", "task-callback-test");
const PROJECT_ID = "test-project";
const CALLBACK_URL = "https://example.com/webhook";

function makeConfig(overrides: Partial<any> = {}): Config {
  const serverConfig = {
    workspaceDir: TMP,
    maxConcurrentTasks: 3,
    metaCpus: 0.4,
    sandboxCpus: 0.4,
    ...(overrides.server ?? {}),
  };

  const projectConfigs: Record<string, any> = overrides.projects ?? {
    [PROJECT_ID]: {
      maxConcurrentTasks: 4,
      repositories: [
        { name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" },
      ],
      claudeCode: {
        command: "claude",
      },
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
  const branch = overrides.branch === null || overrides.branch === undefined
    ? undefined
    : (typeof overrides.branch === "string" ? makeBranch(overrides.branch) : overrides.branch);

  return {
    taskId: "abc123",
    projectId: PROJECT_ID,
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

function createTask(overrides: Partial<any> = {}): Task {
  const config = makeConfig(overrides.configOverrides);
  const tm = new TaskManager(config);
  const data = makePersistedTask({
    status: "running",
    completedAt: null,
    callbackUrl: CALLBACK_URL,
    branch: "impl/test-branch",
    ...overrides,
  });
  return new Task(data, tm);
}

describe("Task callback (callbackUrl)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("complete() sends callback with correct payload", () => {
    const task = createTask();
    task.complete();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(CALLBACK_URL);
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body.taskId).toBe("abc123");
    expect(body.status).toBe("completed");
    expect(body.branch).toBe("impl/test-branch");
    expect(body.prompt).toBe("Add a button");
    expect(body.completedAt).toBeTruthy();
    expect(body.error).toBeNull();
    expect(body.pullRequests).toBeNull();
  });

  it("fail() sends callback when status is terminal (failed)", () => {
    const task = createTask();
    task.fail("something broke");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.status).toBe("failed");
    expect(body.error).toBe("something broke");
  });

  it("fail() does NOT send callback when status is retrying", () => {
    const task = createTask({
      configOverrides: {
        projects: {
          [PROJECT_ID]: {
            maxConcurrentTasks: 4,
            repositories: [
              { name: "my-repo", url: "https://github.com/test/repo.git", defaultBranch: "main" },
            ],
            claudeCode: { command: "claude" },
            errorRetry: { maxAttempts: 3, delaySeconds: 60 },
          },
        },
      },
    });
    task.fail("transient error");

    expect(task.data.status).toBe("retrying");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("completePipeline() sends callback", () => {
    const task = createTask({ status: "waiting_for_pipeline" });
    task.completePipeline();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.status).toBe("completed");
  });

  it("failPipeline() sends callback", () => {
    const task = createTask({ status: "waiting_for_pipeline" });
    task.failPipeline("CI check X failed");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.status).toBe("failed");
    expect(body.error).toBe("CI check X failed");
  });

  it("cancel() sends callback", async () => {
    const task = createTask({ status: "queued" });
    await task.cancel();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.status).toBe("cancelled");
  });

  it("does NOT send callback when callbackUrl is not set", () => {
    const task = createTask({ callbackUrl: undefined });
    task.complete();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("includes pullRequests in callback payload when present", () => {
    const prs = [{ repo: "my-repo", url: "https://github.com/test/repo/pull/1" }];
    const task = createTask({ pullRequests: prs });
    task.complete();

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.pullRequests).toEqual(prs);
  });

  it("logs warning when callback returns non-ok status", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const task = createTask();
    task.complete();

    // Wait for the async fetch to resolve
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Callback to"),
        // Not checking exact message, just that it warns
      );
    });
  });

  it("logs error when callback fetch throws", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network error"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const task = createTask();
    task.complete();

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Callback to"),
        expect.stringContaining("network error"),
      );
    });
  });
});
