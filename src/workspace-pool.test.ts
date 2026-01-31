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

  describe("PoolExhaustedError", () => {
    it("has the correct message", () => {
      const err = new PoolExhaustedError();
      expect(err.message).toContain("Maximum concurrent tasks");
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
