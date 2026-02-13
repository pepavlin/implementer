import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { GitManager } from "./git-manager.js";

const TMP = join(import.meta.dirname, "..", "tmp", "git-manager-test");

// Helper to run shell commands in tests
function shell(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("bash", ["-c", cmd], { cwd }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

// Create a bare git repo to act as "origin"
async function createBareRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await shell("git init --bare", dir);
}

// Create a cloned repo from the bare repo with an initial commit
async function createClonedRepo(bareDir: string, cloneDir: string): Promise<void> {
  mkdirSync(cloneDir, { recursive: true });
  await shell(`git clone ${bareDir} .`, cloneDir);
  await shell('git config user.email "test@test.com"', cloneDir);
  await shell('git config user.name "Test"', cloneDir);
  await shell("echo init > file.txt && git add . && git commit -m 'init'", cloneDir);
  await shell("git push origin main", cloneDir);
}

describe("GitManager", () => {
  let gm: GitManager;

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    gm = new GitManager();
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  describe("createPullRequestAll", () => {
    it("skips repos not on the target branch", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Stay on main, not on impl branch
      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      const results = await gm.createPullRequestAll(workDir, repos, "impl/test-branch", "Test PR", "Body");

      expect(results).toEqual([]);
    });

    it("handles gh CLI not available gracefully", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Create and checkout the impl branch
      await shell("git checkout -b impl/test-branch", repoDir);
      await shell("echo change > file2.txt && git add . && git commit -m 'change'", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];

      // gh CLI won't work on a local bare repo — should handle gracefully
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const results = await gm.createPullRequestAll(workDir, repos, "impl/test-branch", "Test PR", "Body");
      consoleSpy.mockRestore();

      // Should return empty array (no crash), since gh can't create PR on local repo
      expect(results).toEqual([]);
    });

    it("returns empty array when no repos match the branch", async () => {
      const workDir = join(TMP, "workspace");
      mkdirSync(workDir, { recursive: true });

      const repos = [{ name: "nonexistent-repo", url: "https://example.com", defaultBranch: "main" }];
      const results = await gm.createPullRequestAll(workDir, repos, "impl/test", "Title", "Body");

      expect(results).toEqual([]);
    });
  });
});
