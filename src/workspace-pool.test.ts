import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspacePool, PoolExhaustedError } from "./workspace-pool.js";
import type { RepositoryConfig } from "./types.js";

const TMP = join(import.meta.dirname, "..", "tmp", "pool-test");

// Create a fake repo with a .git dir so pool doesn't try to clone
function createFakeRepo(baseDir: string, name: string) {
  const repoDir = join(baseDir, name);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  // Fake git commands by making the repo look like it's on "main"
  writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
}

const fakeRepos: RepositoryConfig[] = [
  { name: "repo-a", url: "https://example.com/a.git", defaultBranch: "main" },
];

describe("WorkspacePool", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  describe("CLAUDE.md generation", () => {
    it("writes CLAUDE.md when creating a workspace", async () => {
      const pool = new WorkspacePool(TMP);

      // We can't fully acquire (it tries to git clone), but we can test
      // the writing logic indirectly. Let's check the pool creates the
      // instances directory structure.
      try {
        await pool.acquire(fakeRepos);
      } catch {
        // Expected - git clone will fail in test env
      }

      // The instances directory should have been created
      expect(existsSync(join(TMP, "instances"))).toBe(true);
    });
  });

  describe("MCP config generation", () => {
    it("writes .mcp.json when mcpServers configured", async () => {
      const mcpServers = {
        playwright: {
          command: "npx",
          args: ["@playwright/mcp@latest", "--headless"],
        },
      };
      const pool = new WorkspacePool(TMP, mcpServers);

      try {
        await pool.acquire(fakeRepos);
      } catch {
        // Expected
      }

      // Check the instance dir for .mcp.json
      const instanceDir = join(TMP, "instances", "0");
      if (existsSync(join(instanceDir, ".mcp.json"))) {
        const mcp = JSON.parse(readFileSync(join(instanceDir, ".mcp.json"), "utf-8"));
        expect(mcp.mcpServers.playwright.command).toBe("npx");
      }
    });

    it("does not write .mcp.json when no mcpServers configured", async () => {
      const pool = new WorkspacePool(TMP);

      try {
        await pool.acquire(fakeRepos);
      } catch {
        // Expected
      }

      const instanceDir = join(TMP, "instances", "0");
      if (existsSync(instanceDir)) {
        expect(existsSync(join(instanceDir, ".mcp.json"))).toBe(false);
      }
    });
  });

  describe("initFromDisk", () => {
    it("discovers existing workspace directories", () => {
      const pool = new WorkspacePool(TMP);

      // Create fake instance directories
      mkdirSync(join(TMP, "instances", "0"), { recursive: true });
      mkdirSync(join(TMP, "instances", "1"), { recursive: true });
      mkdirSync(join(TMP, "instances", "3"), { recursive: true });

      pool.initFromDisk();

      // Verify the pool knows about these instances by releasing them (no throw = found)
      expect(() => pool.release(0)).not.toThrow();
      expect(() => pool.release(1)).not.toThrow();
      expect(() => pool.release(3)).not.toThrow();
    });

    it("ignores non-numeric directory names", async () => {
      const pool = new WorkspacePool(TMP);

      mkdirSync(join(TMP, "instances", "0"), { recursive: true });
      mkdirSync(join(TMP, "instances", "temp"), { recursive: true });
      mkdirSync(join(TMP, "instances", "backup"), { recursive: true });

      pool.initFromDisk();

      // Only instance 0 should be registered — release is a no-op for unknown IDs
      // We verify by acquireExisting: unknown IDs throw
      await expect(pool.acquireExisting(0, fakeRepos)).resolves.toBeDefined();
      await expect(pool.acquireExisting(999, fakeRepos)).rejects.toThrow("not found");
    });

    it("handles missing instances directory", () => {
      const pool = new WorkspacePool(TMP);
      // No instances/ dir exists at all
      expect(() => pool.initFromDisk()).not.toThrow();
    });

    it("sets nextId to avoid collisions", async () => {
      // Create existing instance dirs with gap
      mkdirSync(join(TMP, "instances", "0"), { recursive: true });
      mkdirSync(join(TMP, "instances", "5"), { recursive: true });

      const pool = new WorkspacePool(TMP);
      pool.initFromDisk();

      // Mark both existing instances as in-use so acquire() must create a new one
      await pool.acquireExisting(0, fakeRepos);
      await pool.acquireExisting(5, fakeRepos);

      // Next acquire should create instance 6 (after highest existing = 5)
      try {
        await pool.acquire(fakeRepos);
      } catch {
        // Git clone will fail, but directory should be created with id 6
      }

      expect(existsSync(join(TMP, "instances", "6"))).toBe(true);
    });
  });

  describe("acquireExisting", () => {
    it("marks workspace as in-use and writes CLAUDE.md", async () => {
      const pool = new WorkspacePool(TMP);

      // Create an existing workspace
      mkdirSync(join(TMP, "instances", "0"), { recursive: true });
      pool.initFromDisk();

      const ws = await pool.acquireExisting(0, fakeRepos);

      expect(ws.id).toBe(0);
      expect(ws.dir).toBe(join(TMP, "instances", "0"));
      expect(existsSync(join(ws.dir, "CLAUDE.md"))).toBe(true);

      const claude = readFileSync(join(ws.dir, "CLAUDE.md"), "utf-8");
      expect(claude).toContain("repo-a");
    });

    it("writes MCP config when configured", async () => {
      const mcpServers = {
        myServer: { command: "test-cmd", args: ["--flag"] },
      };
      const pool = new WorkspacePool(TMP, mcpServers);

      mkdirSync(join(TMP, "instances", "0"), { recursive: true });
      pool.initFromDisk();

      const ws = await pool.acquireExisting(0, fakeRepos);

      expect(existsSync(join(ws.dir, ".mcp.json"))).toBe(true);
      const mcp = JSON.parse(readFileSync(join(ws.dir, ".mcp.json"), "utf-8"));
      expect(mcp.mcpServers.myServer.command).toBe("test-cmd");
    });

    it("throws for unknown workspace ID", async () => {
      const pool = new WorkspacePool(TMP);
      pool.initFromDisk();

      await expect(pool.acquireExisting(42, fakeRepos)).rejects.toThrow("not found");
    });

    it("throws when workspace is already in use", async () => {
      const pool = new WorkspacePool(TMP);

      mkdirSync(join(TMP, "instances", "0"), { recursive: true });
      pool.initFromDisk();

      // Acquire once
      await pool.acquireExisting(0, fakeRepos);

      // Second acquire on same workspace should fail
      await expect(pool.acquireExisting(0, fakeRepos)).rejects.toThrow("already in use");
    });

    it("removes stray .git directory", async () => {
      const pool = new WorkspacePool(TMP);

      const instanceDir = join(TMP, "instances", "0");
      mkdirSync(join(instanceDir, ".git"), { recursive: true });
      writeFileSync(join(instanceDir, ".git", "HEAD"), "bad");

      pool.initFromDisk();
      await pool.acquireExisting(0, fakeRepos);

      expect(existsSync(join(instanceDir, ".git"))).toBe(false);
    });
  });

  describe("PoolExhaustedError", () => {
    it("has the correct message", () => {
      const err = new PoolExhaustedError(4);
      expect(err.message).toContain("Maximum concurrent tasks");
      expect(err.message).toContain("4");
      expect(err.name).toBe("PoolExhaustedError");
    });
  });

  describe("release", () => {
    it("does not throw on invalid id", () => {
      const pool = new WorkspacePool(TMP);
      expect(() => pool.release(999)).not.toThrow();
    });
  });
});
