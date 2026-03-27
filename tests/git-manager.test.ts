import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { GitManager } from "../src/git-manager.js";

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
  await shell("git init --bare -b main", dir);
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

  describe("ensureAllRepos", () => {
    it("re-clones when .git exists but repo is corrupted", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Corrupt the repo by wiping .git contents (directory still exists but is invalid)
      rmSync(join(repoDir, ".git"), { recursive: true });
      mkdirSync(join(repoDir, ".git"), { recursive: true });

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      // Should recover by re-cloning instead of throwing
      await gm.ensureAllRepos(workDir, repos);

      // Verify the repo is now valid and functional
      const branch = await shell("git rev-parse --abbrev-ref HEAD", repoDir);
      expect(branch).toBe("main");

      // Verify fetch works on the recovered repo
      await expect(shell("git fetch origin", repoDir)).resolves.not.toThrow();
    });

    it("re-clones when directory exists but .git is missing", async () => {
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");
      const bareDir = join(TMP, "bare-repo");

      await createBareRepo(bareDir);
      // Create a temporary clone to push initial commit
      const tmpClone = join(TMP, "tmp-init");
      mkdirSync(tmpClone, { recursive: true });
      await shell(`git clone ${bareDir} .`, tmpClone);
      await shell('git config user.email "test@test.com"', tmpClone);
      await shell('git config user.name "Test"', tmpClone);
      await shell("echo init > file.txt && git add . && git commit -m 'init' && git push origin main", tmpClone);

      // Create a non-git directory with leftover files (simulates partial clone failure)
      mkdirSync(repoDir, { recursive: true });
      await shell("echo leftover > leftover.txt", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      // Should clean up and clone successfully
      await gm.ensureAllRepos(workDir, repos);

      // Verify the repo is valid
      const branch = await shell("git rev-parse --abbrev-ref HEAD", repoDir);
      expect(branch).toBe("main");
    });

    it("fetches normally when repo is healthy", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      // Should succeed without re-cloning
      await gm.ensureAllRepos(workDir, repos);

      const branch = await shell("git rev-parse --abbrev-ref HEAD", repoDir);
      expect(branch).toBe("main");
    });

    it("re-clones when origin URL does not match (workspace reused by different dynamic task)", async () => {
      const bareDir1 = join(TMP, "bare-repo-1");
      const bareDir2 = join(TMP, "bare-repo-2");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      // Set up two separate bare repos (simulating two different GitHub repos with the same name)
      await createBareRepo(bareDir1);
      await createBareRepo(bareDir2);

      // Push initial commits to both
      const tmpClone1 = join(TMP, "tmp-init-1");
      mkdirSync(tmpClone1, { recursive: true });
      await shell(`git clone ${bareDir1} .`, tmpClone1);
      await shell('git config user.email "test@test.com"', tmpClone1);
      await shell('git config user.name "Test"', tmpClone1);
      await shell("echo repo1 > file.txt && git add . && git commit -m 'init repo1' && git push origin main", tmpClone1);

      const tmpClone2 = join(TMP, "tmp-init-2");
      mkdirSync(tmpClone2, { recursive: true });
      await shell(`git clone ${bareDir2} .`, tmpClone2);
      await shell('git config user.email "test@test.com"', tmpClone2);
      await shell('git config user.name "Test"', tmpClone2);
      await shell("echo repo2 > file.txt && git add . && git commit -m 'init repo2' && git push origin main", tmpClone2);

      // First task clones repo 1 into workspace
      const repos1 = [{ name: "my-repo", url: bareDir1, defaultBranch: "main" }];
      await gm.ensureAllRepos(workDir, repos1);

      // Verify it cloned repo 1
      const content1 = await shell("cat file.txt", repoDir);
      expect(content1).toBe("repo1");

      // Second task (retry with different repoUrl) uses the same workspace directory
      const repos2 = [{ name: "my-repo", url: bareDir2, defaultBranch: "main" }];
      await gm.ensureAllRepos(workDir, repos2);

      // Must have re-cloned to repo 2 (not kept repo 1's origin)
      const content2 = await shell("cat file.txt", repoDir);
      expect(content2).toBe("repo2");

      // Verify origin points to the new repo
      const origin = await shell("git remote get-url origin", repoDir);
      expect(origin).toBe(bareDir2);
    });

    it("re-clones when origin URL differs by .git suffix", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Existing clone has origin = bareDir (without .git suffix).
      // If task provides URL with .git suffix, they should be treated as the same URL.
      const repos = [{ name: "my-repo", url: bareDir + ".git", defaultBranch: "main" }];
      // Should NOT re-clone — URLs normalize to the same value
      await gm.ensureAllRepos(workDir, repos);

      const branch = await shell("git rev-parse --abbrev-ref HEAD", repoDir);
      expect(branch).toBe("main");
    });
  });

  describe("prepareNewBranchAll", () => {
    it("succeeds when there are uncommitted changes in the working tree", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Simulate uncommitted changes left over from a previous task (e.g. after a failed run)
      await shell("echo dirty > file.txt", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      // Should not throw despite local modifications
      await gm.prepareNewBranchAll(workDir, repos, "impl/new-task");

      const branch = await shell("git rev-parse --abbrev-ref HEAD", repoDir);
      expect(branch).toBe("impl/new-task");
    }, 15000);

    it("succeeds when there are staged changes in the working tree", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Simulate staged but uncommitted changes
      await shell("echo staged > file.txt && git add file.txt", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      await gm.prepareNewBranchAll(workDir, repos, "impl/new-task");

      const branch = await shell("git rev-parse --abbrev-ref HEAD", repoDir);
      expect(branch).toBe("impl/new-task");
    });

    it("resets existing local branch to defaultBranch instead of reusing stale commits", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];

      // First task creates the branch and adds a commit (simulates a previous interrupted task)
      await gm.prepareNewBranchAll(workDir, repos, "impl/reused-branch");
      await shell("echo stale-work > stale.txt && git add . && git commit -m 'stale work from previous task'", repoDir);

      // Simulate workspace reuse: switch back to main
      await shell("git checkout main", repoDir);

      // A new task with the same branch name — must NOT inherit stale commits
      await gm.prepareNewBranchAll(workDir, repos, "impl/reused-branch");

      const branch = await shell("git rev-parse --abbrev-ref HEAD", repoDir);
      expect(branch).toBe("impl/reused-branch");

      // Stale work from the previous task must NOT be present — branch was reset to origin/main
      const files = await shell("ls", repoDir);
      expect(files).not.toContain("stale.txt");

      // The branch should point to origin/main HEAD (no extra commits)
      const log = await shell("git log --oneline", repoDir);
      expect(log).not.toContain("stale work from previous task");
    });

    it("resets existing remote branch to defaultBranch when branch was previously pushed", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];

      // Previous task: create branch, commit, and push to remote
      await gm.prepareNewBranchAll(workDir, repos, "impl/reused-branch");
      await shell("echo stale-work > stale.txt && git add . && git commit -m 'stale commit'", repoDir);
      await shell("git push origin impl/reused-branch", repoDir);

      // Simulate workspace reset (pool reuse)
      await shell("git checkout main", repoDir);
      await shell("git branch -D impl/reused-branch", repoDir);

      // New task with same branch name — after fetch, origin/impl/reused-branch exists.
      // prepareNewBranchAll must NOT check out the old remote branch.
      await gm.prepareNewBranchAll(workDir, repos, "impl/reused-branch");

      const branch = await shell("git rev-parse --abbrev-ref HEAD", repoDir);
      expect(branch).toBe("impl/reused-branch");

      // Must NOT contain stale work from the previous task
      const files = await shell("ls", repoDir);
      expect(files).not.toContain("stale.txt");

      const log = await shell("git log --oneline", repoDir);
      expect(log).not.toContain("stale commit");
    });
  });

  describe("resetToDefaultAll", () => {
    it("succeeds when there are uncommitted changes in the working tree", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Checkout a feature branch and add uncommitted changes
      await shell("git checkout -b impl/old-task", repoDir);
      await shell("echo dirty > file.txt", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      // Should not throw — workspace pool calls this when reusing instances
      await gm.resetToDefaultAll(workDir, repos);

      const branch = await shell("git rev-parse --abbrev-ref HEAD", repoDir);
      expect(branch).toBe("main");
    });
  });

  describe("checkoutBranchAll", () => {
    it("succeeds when there are uncommitted changes during PR continuation", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Create and push the PR branch
      await shell("git checkout -b impl/pr-branch", repoDir);
      await shell("echo feature > feature.txt && git add . && git commit -m 'feat'", repoDir);
      await shell("git push origin impl/pr-branch", repoDir);

      // Switch back to main and add uncommitted changes (simulates dirty workspace on retry)
      await shell("git checkout main", repoDir);
      await shell("echo dirty > file.txt", repoDir);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];
      // Should not throw even though working tree is dirty
      await gm.checkoutBranchAll(workDir, repos, "impl/pr-branch");

      const branch = await shell("git rev-parse --abbrev-ref HEAD", repoDir);
      expect(branch).toBe("impl/pr-branch");
    });

    it("succeeds when local branch exists but checkout fails (stale local ref)", async () => {
      const bareDir = join(TMP, "bare-repo");
      const workDir = join(TMP, "workspace");
      const repoDir = join(workDir, "my-repo");

      await createBareRepo(bareDir);
      await createClonedRepo(bareDir, repoDir);

      // Create the branch locally and push it
      await shell("git checkout -b impl/continue-branch", repoDir);
      await shell("echo v1 > feature.txt && git add . && git commit -m 'v1'", repoDir);
      await shell("git push origin impl/continue-branch", repoDir);

      // Simulate workspace reuse: switch to main, then advance origin/impl/continue-branch
      // by pushing from a different clone (simulates parent task completing in another workspace)
      await shell("git checkout main", repoDir);

      const tmpClone = join(TMP, "tmp-clone2");
      mkdirSync(tmpClone, { recursive: true });
      await shell(`git clone ${bareDir} .`, tmpClone);
      await shell('git config user.email "test@test.com"', tmpClone);
      await shell('git config user.name "Test"', tmpClone);
      await shell("git checkout impl/continue-branch", tmpClone);
      await shell("echo v2 > feature.txt && git add . && git commit -m 'v2'", tmpClone);
      await shell("git push origin impl/continue-branch", tmpClone);

      const repos = [{ name: "my-repo", url: bareDir, defaultBranch: "main" }];

      // checkoutBranchAll should succeed and have the latest remote content
      await gm.checkoutBranchAll(workDir, repos, "impl/continue-branch");

      const branch = await shell("git rev-parse --abbrev-ref HEAD", repoDir);
      expect(branch).toBe("impl/continue-branch");

      // Should have the latest content from remote
      const content = await shell("cat feature.txt", repoDir);
      expect(content).toBe("v2");
    });
  });

  describe("deleteRemoteBranchAll", () => {
    it("skips repos not on the target branch", { timeout: 15000 }, async () => {
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
