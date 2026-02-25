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

  describe("deleteRemoteBranchAll", () => {
    it("skips repos not on the target branch", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Stay on main, not on impl branch
      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];

      // Should not throw — just skips
      await gm.deleteRemoteBranchAll(workDir, repos, "impl/test-branch");

      // Verify the remote still has no impl branch (nothing was deleted)
      const branches = await shell("git branch", bareDir);
      expect(branches).toContain("main");
    });

    it("deletes the remote branch when on the target branch", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Create and push the impl branch
      await shell("git checkout -b impl/test-branch", repoDir);
      await shell("git push origin impl/test-branch", repoDir);

      // Verify branch exists on remote
      const branchesBefore = await shell("git branch -r", repoDir);
      expect(branchesBefore).toContain("origin/impl/test-branch");

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      await gm.deleteRemoteBranchAll(workDir, repos, "impl/test-branch");

      // Fetch and verify branch is gone from remote
      await shell("git fetch origin --prune", repoDir);
      const branchesAfter = await shell("git branch -r", repoDir);
      expect(branchesAfter).not.toContain("origin/impl/test-branch");
    });

    it("handles error gracefully when remote branch does not exist", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Create local branch but don't push it
      await shell("git checkout -b impl/test-branch", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Should not throw even though remote branch doesn't exist
      await gm.deleteRemoteBranchAll(workDir, repos, "impl/test-branch");

      consoleSpy.mockRestore();
    });
  });

  describe("rebaseOnDefaultAll", () => {
    it("skips repos not on the target branch", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Stay on main
      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      const result = await gm.rebaseOnDefaultAll(workDir, repos, "impl/test-branch");

      expect(result.rebased).toEqual([]);
      expect(result.conflicted).toEqual([]);
    });

    it("rebases cleanly when no conflicts", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Create feature branch and add a commit
      await shell("git checkout -b impl/feature", repoDir);
      await shell("echo feature > feature.txt && git add . && git commit -m 'feat'", repoDir);

      // Simulate main advancing: push a non-conflicting change to origin/main
      // via a temporary clone
      const tmpClone = join(TMP, "tmp-clone");
      mkdirSync(tmpClone, { recursive: true });
      await shell(`git clone ${bareDir} .`, tmpClone);
      await shell('git config user.email "test@test.com"', tmpClone);
      await shell('git config user.name "Test"', tmpClone);
      await shell("echo upstream > upstream.txt && git add . && git commit -m 'upstream' && git push origin main", tmpClone);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      const result = await gm.rebaseOnDefaultAll(workDir, repos, "impl/feature");

      expect(result.rebased).toEqual(["my-repo"]);
      expect(result.conflicted).toEqual([]);

      // Verify the rebase actually happened — upstream.txt should be in the tree
      const files = await shell("ls", repoDir);
      expect(files).toContain("upstream.txt");
      expect(files).toContain("feature.txt");
    });

    it("aborts and returns conflicted repos on conflict", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Create feature branch and modify file.txt
      await shell("git checkout -b impl/feature", repoDir);
      await shell("echo feature-change > file.txt && git add . && git commit -m 'feat'", repoDir);

      // Simulate conflicting change on main
      const tmpClone = join(TMP, "tmp-clone");
      mkdirSync(tmpClone, { recursive: true });
      await shell(`git clone ${bareDir} .`, tmpClone);
      await shell('git config user.email "test@test.com"', tmpClone);
      await shell('git config user.name "Test"', tmpClone);
      await shell("echo conflicting-change > file.txt && git add . && git commit -m 'conflict' && git push origin main", tmpClone);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      const result = await gm.rebaseOnDefaultAll(workDir, repos, "impl/feature");

      expect(result.rebased).toEqual([]);
      expect(result.conflicted).toHaveLength(1);
      expect(result.conflicted[0].name).toBe("my-repo");

      // Verify rebase was aborted — repo should be in clean state on the branch
      const branch = await shell("git rev-parse --abbrev-ref HEAD", repoDir);
      expect(branch).toBe("impl/feature");
      const status = await shell("git status --porcelain", repoDir);
      expect(status).toBe("");
    });
  });

  describe("pushBranchAll", () => {
    it("pushes with --force-with-lease when force is true", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Create branch, push it, then amend (simulating rebase rewriting history)
      await shell("git checkout -b impl/feature", repoDir);
      await shell("echo v1 > new.txt && git add . && git commit -m 'v1'", repoDir);
      await shell("git push origin impl/feature", repoDir);

      // Amend the commit (rewrites history like rebase would)
      await shell("echo v2 > new.txt && git add . && git commit --amend -m 'v2'", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];

      // Regular push would fail, force push should succeed
      await gm.pushBranchAll(workDir, repos, "impl/feature", true);

      // Verify the force-pushed content reached the remote
      const tmpClone = join(TMP, "verify-clone");
      mkdirSync(tmpClone, { recursive: true });
      await shell(`git clone ${bareDir} .`, tmpClone);
      await shell("git checkout impl/feature", tmpClone);
      const content = await shell("cat new.txt", tmpClone);
      expect(content).toBe("v2");
    });
  });

  describe("getCommitLogAll", () => {
    it("returns commit subjects as markdown bullets", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Record pre-run head
      const preHead = await shell("git rev-parse HEAD", repoDir);

      // Create branch and add commits
      await shell("git checkout -b impl/feature", repoDir);
      await shell("echo a > a.txt && git add . && git commit -m 'feat: add animated hero'", repoDir);
      await shell("echo b > b.txt && git add . && git commit -m 'fix: resolve hover styles'", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      const sinceHeads = new Map([["my-repo", preHead]]);

      const logs = await gm.getCommitLogAll(workDir, repos, "impl/feature", sinceHeads);

      expect(logs.has("my-repo")).toBe(true);
      const log = logs.get("my-repo")!;
      expect(log).toContain("- feat: add animated hero");
      expect(log).toContain("- fix: resolve hover styles");
    });

    it("skips repos not on the target branch", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      const preHead = await shell("git rev-parse HEAD", repoDir);
      // Stay on main
      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      const sinceHeads = new Map([["my-repo", preHead]]);

      const logs = await gm.getCommitLogAll(workDir, repos, "impl/feature", sinceHeads);
      expect(logs.size).toBe(0);
    });

    it("skips repos with no sinceHead entry", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      await shell("git checkout -b impl/feature", repoDir);
      await shell("echo a > a.txt && git add . && git commit -m 'feat'", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      const sinceHeads = new Map<string, string>(); // empty map

      const logs = await gm.getCommitLogAll(workDir, repos, "impl/feature", sinceHeads);
      expect(logs.size).toBe(0);
    });

    it("returns empty map when no new commits exist", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      await shell("git checkout -b impl/feature", repoDir);
      const head = await shell("git rev-parse HEAD", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      const sinceHeads = new Map([["my-repo", head]]);

      const logs = await gm.getCommitLogAll(workDir, repos, "impl/feature", sinceHeads);
      // HEAD..HEAD produces no output, so repo won't be in the map
      expect(logs.size).toBe(0);
    });
  });

  describe("revertProtectedPathsAll", () => {
    it("is a no-op when protectedPaths is empty", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);
      await shell("git checkout -b impl/feature", repoDir);
      await shell("echo changed > file.txt && git add . && git commit -m 'change'", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      await gm.revertProtectedPathsAll(workDir, repos, []);

      // No cleanup commit should be created
      const log = await shell("git log --oneline", repoDir);
      expect(log).not.toContain("revert changes to protected paths");
    });

    it("reverts a committed change to a protected file", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Create a "Dockerfile" in main (simulates a protected file already in base)
      await shell("echo 'FROM node:20' > Dockerfile && git add . && git commit -m 'add Dockerfile' && git push origin main", repoDir);

      // Create feature branch and modify the protected file
      await shell("git checkout -b impl/feature", repoDir);
      await shell("echo 'FROM python:3.11' > Dockerfile && git add . && git commit -m 'feat: change Dockerfile'", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      await gm.revertProtectedPathsAll(workDir, repos, ["Dockerfile"]);

      // Dockerfile should be restored to base version
      const content = await shell("cat Dockerfile", repoDir);
      expect(content).toBe("FROM node:20");

      // A cleanup commit should have been created
      const log = await shell("git log --oneline", repoDir);
      expect(log).toContain("revert changes to protected paths");
    });

    it("removes a protected file that was added by Claude", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Feature branch: add a new protected file that doesn't exist in base
      await shell("git checkout -b impl/feature", repoDir);
      await shell("mkdir -p .github/workflows && echo 'on: push' > .github/workflows/ci.yml && git add . && git commit -m 'feat: add CI workflow'", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      await gm.revertProtectedPathsAll(workDir, repos, [".github"]);

      // The .github directory should be gone
      const status = await shell("git status --porcelain", repoDir);
      expect(status).toBe("");
      const files = await shell("git ls-files .github", repoDir);
      expect(files.trim()).toBe("");

      // A cleanup commit should have been created
      const log = await shell("git log --oneline", repoDir);
      expect(log).toContain("revert changes to protected paths");
    });

    it("restores a protected file that was deleted by Claude", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Add Dockerfile to main
      await shell("echo 'FROM node:20' > Dockerfile && git add . && git commit -m 'add Dockerfile' && git push origin main", repoDir);

      // Feature branch: delete the protected file
      await shell("git checkout -b impl/feature", repoDir);
      await shell("git rm Dockerfile && git commit -m 'feat: remove Dockerfile'", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      await gm.revertProtectedPathsAll(workDir, repos, ["Dockerfile"]);

      // Dockerfile should be back
      const content = await shell("cat Dockerfile", repoDir);
      expect(content).toBe("FROM node:20");

      const log = await shell("git log --oneline", repoDir);
      expect(log).toContain("revert changes to protected paths");
    });

    it("reverts uncommitted (staged) changes to protected files", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      await shell("echo 'FROM node:20' > Dockerfile && git add . && git commit -m 'add Dockerfile' && git push origin main", repoDir);
      await shell("git checkout -b impl/feature", repoDir);

      // Stage a change but do not commit it
      await shell("echo 'FROM python:3' > Dockerfile && git add Dockerfile", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      await gm.revertProtectedPathsAll(workDir, repos, ["Dockerfile"]);

      const content = await shell("cat Dockerfile", repoDir);
      expect(content).toBe("FROM node:20");
    });

    it("skips repos on the default branch", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Stay on main — no branch checkout
      await shell("echo 'FROM python' > Dockerfile && git add . && git commit -m 'change'", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      // Should skip silently — we're on main
      await gm.revertProtectedPathsAll(workDir, repos, ["Dockerfile"]);

      // No cleanup commit (the original commit is still there, not cleaned up)
      const log = await shell("git log --oneline", repoDir);
      expect(log).not.toContain("revert changes to protected paths");
    });

    it("leaves non-protected files untouched", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      await shell("git checkout -b impl/feature", repoDir);
      // Modify a non-protected file and also add a protected file
      await shell("echo 'app code' > src.js && echo 'FROM python' > Dockerfile && git add . && git commit -m 'feat: changes'", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      await gm.revertProtectedPathsAll(workDir, repos, ["Dockerfile"]);

      // src.js should still have the change
      const srcContent = await shell("cat src.js", repoDir);
      expect(srcContent).toBe("app code");

      // Dockerfile should be gone (it was added; base had none)
      const files = await shell("git ls-files Dockerfile", repoDir);
      expect(files.trim()).toBe("");
    });
  });

  describe("commentOnPullRequestAll", () => {
    it("logs error when gh fails and does not throw", async () => {
      const workDir = join(TMP, "workspace");
      mkdirSync(workDir, { recursive: true });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const pullRequests = [{ repo: "my-repo", url: "https://github.com/test/repo/pull/1" }];

      // gh will fail since this is not a real repo — should not throw
      await gm.commentOnPullRequestAll(workDir, pullRequests, "## Task\n\nDo something");

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("handles empty pull requests array", async () => {
      const workDir = join(TMP, "workspace");
      mkdirSync(workDir, { recursive: true });

      // Should not throw
      await gm.commentOnPullRequestAll(workDir, [], "comment");
    });
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

    it("handles gh CLI with draft flag gracefully", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Create and checkout the impl branch
      await shell("git checkout -b impl/test-branch", repoDir);
      await shell("echo change > file2.txt && git add . && git commit -m 'change'", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];

      // gh CLI won't work on a local bare repo — should handle gracefully even with draft
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const results = await gm.createPullRequestAll(workDir, repos, "impl/test-branch", "Test PR", "Body", true);
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

  describe("getPullRequestBranch", () => {
    it("throws when gh fails (e.g. PR does not exist or no GitHub auth)", async () => {
      const workDir = join(TMP, "workspace");
      mkdirSync(workDir, { recursive: true });

      const repoConfig = { name: "my-repo", url: "https://github.com/nonexistent-org/nonexistent-repo.git", defaultBranch: "main" };
      // gh pr view will fail in the test environment — verify the error is propagated
      await expect(gm.getPullRequestBranch(999, repoConfig, workDir)).rejects.toThrow();
    });

    it("includes the correct owner/repo in the gh error message", async () => {
      const workDir = join(TMP, "workspace");
      mkdirSync(workDir, { recursive: true });

      const repoConfig = { name: "my-repo", url: "https://github.com/myorg/myrepo.git", defaultBranch: "main" };
      let caughtError: unknown;
      try {
        await gm.getPullRequestBranch(42, repoConfig, workDir);
      } catch (err) {
        caughtError = err;
      }
      // The gh error should reference the parsed owner/repo (not the full .git URL)
      expect(String(caughtError)).toContain("myorg/myrepo");
    });
  });
});
