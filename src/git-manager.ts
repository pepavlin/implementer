import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PullRequest } from "./types.js";
import type { RepositoryConfig } from "./config/config-types.js";

function git(args: string[], cwd: string, githubToken?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // When a GitHub token is provided, inject it via http.extraHeader using
    // Basic auth (x-access-token:TOKEN), the format GitHub expects for PATs
    // and fine-grained tokens in git HTTPS operations.
    const fullArgs = githubToken
      ? [
          "-c", `http.https://github.com/.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString("base64")}`,
          "-c", "credential.helper=",
          ...args,
        ]
      : args;
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    execFile("git", fullArgs, { cwd, env, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function gh(args: string[], cwd: string, githubToken?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = githubToken ? { ...process.env, GH_TOKEN: githubToken } : undefined;
    execFile("gh", args, { cwd, env, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`gh ${args.join(" ")} failed: ${stderr || error.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

export class GitManager {
  private getRepoDir(baseDir: string, repoName: string): string {
    return join(baseDir, repoName);
  }

  /**
   * Ensure all repos are cloned and up to date.
   */
  async ensureAllRepos(baseDir: string, repos: RepositoryConfig[], githubToken?: string): Promise<void> {
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }

    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);

      if (existsSync(join(repoDir, ".git"))) {
        // Verify the origin remote URL matches the expected repo URL.
        // When workspaces are reused across different dynamic tasks (each with
        // its own repoUrl), the origin may point to a completely different
        // repository. Without this check, fetch/push/PR operations would
        // silently target the wrong repo — breaking retries and continuations
        // for tasks that use a custom githubToken + repoUrl.
        try {
          const currentOrigin = await git(["remote", "get-url", "origin"], repoDir);
          const normalizeUrl = (u: string) => u.replace(/\.git$/, "").toLowerCase();
          if (normalizeUrl(currentOrigin) !== normalizeUrl(repo.url)) {
            console.log(
              `[git-manager] Origin URL mismatch in ${repo.name} (have: ${currentOrigin}, want: ${repo.url}) — re-cloning`
            );
            rmSync(repoDir, { recursive: true, force: true });
            mkdirSync(repoDir, { recursive: true });
            await git(["clone", repo.url, repoDir], baseDir, githubToken);
            continue;
          }
        } catch {
          // If we can't read the remote, fall through to the fetch attempt
        }

        try {
          await git(["fetch", "origin"], repoDir, githubToken);
        } catch (err) {
          // Repository is corrupted (e.g. incomplete clone, Claude ran git init).
          // Delete and re-clone from scratch.
          console.warn(
            `[git-manager] Fetch failed in ${repo.name}, re-cloning: ${err instanceof Error ? err.message : String(err)}`
          );
          rmSync(repoDir, { recursive: true, force: true });
          mkdirSync(repoDir, { recursive: true });
          await git(["clone", repo.url, repoDir], baseDir, githubToken);
        }
      } else {
        // Clean up any leftover non-git directory before cloning
        if (existsSync(repoDir)) {
          rmSync(repoDir, { recursive: true, force: true });
        }
        mkdirSync(repoDir, { recursive: true });
        await git(["clone", repo.url, repoDir], baseDir, githubToken);
      }
    }
  }

  /**
   * Create a new branch from the default branch in all repos.
   * Always resets the branch to origin/defaultBranch, even if a local or remote
   * branch with the same name already exists (e.g. from an interrupted previous run).
   * Using `checkout -B` prevents commits from a previous task leaking into a new one.
   */
  async prepareNewBranchAll(baseDir: string, repos: RepositoryConfig[], branchName: string, githubToken?: string): Promise<void> {
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);
      await git(["fetch", "origin"], repoDir, githubToken);
      await git(["reset", "--hard", "HEAD"], repoDir);
      await git(["checkout", repo.defaultBranch], repoDir);
      await git(["reset", "--hard", `origin/${repo.defaultBranch}`], repoDir);
      // Use -B to create the branch if it doesn't exist, or reset it to the current
      // position (origin/defaultBranch) if it does. This guarantees a clean start
      // with no leftover commits, regardless of whether the branch previously existed.
      await git(["checkout", "-B", branchName], repoDir);
    }
  }

  /**
   * Checkout an existing branch in all repos.
   */
  async checkoutBranchAll(baseDir: string, repos: RepositoryConfig[], branchName: string, githubToken?: string): Promise<void> {
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);
      await git(["fetch", "origin"], repoDir, githubToken);
      await git(["reset", "--hard", "HEAD"], repoDir);

      try {
        await git(["checkout", branchName], repoDir);
      } catch {
        try {
          await git(["checkout", "-b", branchName, `origin/${branchName}`], repoDir);
        } catch {
          // Branch doesn't exist in this repo - stay on current branch
          continue;
        }
      }

      // Ensure local branch is up-to-date with remote.
      // Use reset --hard instead of pull to handle diverged histories
      // (e.g. remote was force-pushed by a previous retry/timeout).
      try {
        await git(["reset", "--hard", `origin/${branchName}`], repoDir);
      } catch {
        // Branch may not exist on remote yet — local-only is fine
      }
    }
  }

  /**
   * Reset all repos to their default branch and pull latest.
   */
  async resetToDefaultAll(baseDir: string, repos: RepositoryConfig[], githubToken?: string): Promise<void> {
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);
      await git(["fetch", "origin"], repoDir, githubToken);
      await git(["reset", "--hard", "HEAD"], repoDir);
      await git(["checkout", repo.defaultBranch], repoDir);
      await git(["reset", "--hard", `origin/${repo.defaultBranch}`], repoDir);
    }
  }

  /**
   * Get the current HEAD hash for all repos.
   */
  async getHeadAll(baseDir: string, repos: RepositoryConfig[]): Promise<Map<string, string>> {
    const heads = new Map<string, string>();
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);
      const head = await git(["rev-parse", "HEAD"], repoDir);
      heads.set(repo.name, head);
    }
    return heads;
  }

  /**
   * After Claude Code runs, ensure the impl branch points to HEAD for any repo
   * where new commits were made. Handles the case where Claude switched branches.
   * Returns true if any repo had new commits.
   */
  async ensureBranchAtHeadAll(
    baseDir: string,
    repos: RepositoryConfig[],
    branchName: string,
    preRunHeads: Map<string, string>,
  ): Promise<boolean> {
    let hasChanges = false;
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);
      try {
        const currentHead = await git(["rev-parse", "HEAD"], repoDir);
        const preHead = preRunHeads.get(repo.name);
        if (currentHead === preHead) continue;

        hasChanges = true;
        const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
        if (currentBranch !== branchName) {
          // Claude switched branches — move our branch to current HEAD and check it out
          await git(["branch", "-f", branchName, "HEAD"], repoDir);
          await git(["checkout", branchName], repoDir);
        }
      } catch {
        continue;
      }
    }
    return hasChanges;
  }

  /**
   * Check if any repo has uncommitted changes (staged or unstaged, excluding untracked).
   */
  async hasUncommittedChanges(baseDir: string, repos: RepositoryConfig[]): Promise<boolean> {
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);
      try {
        const status = await git(["status", "--porcelain"], repoDir);
        // Filter out untracked files (lines starting with "??") and macOS resource forks
        const meaningful = status.split("\n").filter((line) => {
          if (!line.trim()) return false;
          if (line.startsWith("??")) return false;
          return true;
        });
        if (meaningful.length > 0) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  /**
   * Push the branch in all repos that are currently on it.
   * When force is true, uses --force-with-lease (needed after rebase).
   */
  async pushBranchAll(baseDir: string, repos: RepositoryConfig[], branchName: string, force = false, githubToken?: string): Promise<void> {
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);

      try {
        const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
        if (currentBranch !== branchName) continue;
      } catch {
        continue;
      }

      const args = ["push", "origin", branchName];
      if (force) args.push("--force-with-lease");
      await git(args, repoDir, githubToken);
    }
  }

  /**
   * Rebase the branch on the latest default branch in all repos that are on it.
   * Fetches origin first, then attempts rebase. If rebase fails (conflicts),
   * aborts it and returns the repo in the conflicted list.
   */
  async rebaseOnDefaultAll(
    baseDir: string,
    repos: RepositoryConfig[],
    branchName: string,
    githubToken?: string,
  ): Promise<{ rebased: string[]; conflicted: RepositoryConfig[] }> {
    const rebased: string[] = [];
    const conflicted: RepositoryConfig[] = [];

    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);

      try {
        const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
        if (currentBranch !== branchName) continue;
      } catch {
        continue;
      }

      await git(["fetch", "origin"], repoDir, githubToken);

      try {
        await git(["rebase", `origin/${repo.defaultBranch}`], repoDir);
        rebased.push(repo.name);
      } catch {
        // Rebase failed — abort and mark as conflicted
        try {
          await git(["rebase", "--abort"], repoDir);
        } catch {
          // Abort might fail if rebase wasn't actually in progress
        }
        conflicted.push(repo);
      }
    }

    return { rebased, conflicted };
  }

  /**
   * Delete the remote branch in all repos that are currently on the given branch.
   * Best-effort: errors are logged but not thrown.
   */
  async deleteRemoteBranchAll(baseDir: string, repos: RepositoryConfig[], branchName: string, githubToken?: string): Promise<void> {
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);

      try {
        const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
        if (currentBranch !== branchName) continue;
      } catch {
        continue;
      }

      try {
        await git(["push", "origin", "--delete", branchName], repoDir, githubToken);
      } catch (err) {
        console.error(`[git-manager] Failed to delete remote branch ${branchName} in ${repo.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Get commit log (as markdown bullet list) for all repos since given HEAD refs.
   * Returns a Map<repoName, markdownBulletList>.
   */
  async getCommitLogAll(
    baseDir: string,
    repos: RepositoryConfig[],
    branchName: string,
    sinceHeads: Map<string, string>,
  ): Promise<Map<string, string>> {
    const logs = new Map<string, string>();
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);

      try {
        const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
        if (currentBranch !== branchName) continue;
      } catch {
        continue;
      }

      const sinceHead = sinceHeads.get(repo.name);
      if (!sinceHead) continue;

      try {
        const log = await git(["log", `${sinceHead}..HEAD`, "--format=- %s"], repoDir);
        if (log) logs.set(repo.name, log);
      } catch {
        continue;
      }
    }
    return logs;
  }

  /**
   * Revert any changes to protected paths so they never appear in a PR.
   * Handles committed changes (creates a cleanup commit) and uncommitted changes.
   * Skips repos that are on the default branch.
   */
  async revertProtectedPathsAll(
    baseDir: string,
    repos: RepositoryConfig[],
    protectedPaths: string[],
  ): Promise<void> {
    if (protectedPaths.length === 0) return;

    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);

      let currentBranch: string;
      try {
        currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
      } catch {
        continue;
      }
      // Only enforce on feature branches — never on the default branch itself
      if (currentBranch === repo.defaultBranch) continue;

      const base = `origin/${repo.defaultBranch}`;
      const revertedFiles: string[] = [];

      for (const pattern of protectedPaths) {
        // Collect all changed files for this pattern across committed, staged, and unstaged
        const changedFiles = new Set<string>();

        // Committed changes vs base branch
        try {
          const output = await git(["diff", "--name-only", base, "HEAD", "--", pattern], repoDir);
          for (const f of output.split("\n").filter((f) => f.trim())) changedFiles.add(f);
        } catch { /* ignore */ }

        // Staged (indexed) changes not yet committed
        try {
          const output = await git(["diff", "--cached", "--name-only", "--", pattern], repoDir);
          for (const f of output.split("\n").filter((f) => f.trim())) changedFiles.add(f);
        } catch { /* ignore */ }

        // Unstaged working-tree changes
        try {
          const output = await git(["diff", "--name-only", "--", pattern], repoDir);
          for (const f of output.split("\n").filter((f) => f.trim())) changedFiles.add(f);
        } catch { /* ignore */ }

        for (const file of changedFiles) {
          // Determine whether the file exists in the base branch
          const existsInBase = await git(["cat-file", "-e", `${base}:${file}`], repoDir)
            .then(() => true)
            .catch(() => false);

          if (existsInBase) {
            // Restore to base version (stages the restored content, updates working tree)
            try {
              await git(["checkout", base, "--", file], repoDir);
              revertedFiles.push(file);
            } catch { /* ignore */ }
          } else {
            // File was added by Claude — remove it entirely
            try {
              await git(["rm", "--force", "-r", "--cached", file], repoDir);
              // Remove from working tree too (best-effort)
              const { rm } = await import("node:fs/promises");
              await rm(join(repoDir, file), { recursive: true, force: true }).catch(() => {});
              revertedFiles.push(file);
            } catch { /* ignore */ }
          }
        }
      }

      if (revertedFiles.length === 0) continue;

      // Commit staged restorations (if any files were reverted from committed history)
      const staged = await git(["diff", "--cached", "--name-only"], repoDir).catch(() => "");
      if (staged.trim()) {
        await git(
          ["commit", "-m", "chore: revert changes to protected paths"],
          repoDir,
        );
      }

      console.log(
        `[git-manager] Reverted protected path(s) in ${repo.name}: ${revertedFiles.join(", ")}`,
      );
    }
  }

  /**
   * Resolve the head branch name of a pull request by its number.
   * Uses the gh CLI with --repo so it works from any working directory.
   * The repo URL is expected to be a GitHub HTTPS URL (https://github.com/owner/repo.git).
   */
  async getPullRequestBranch(prNumber: number, repoConfig: RepositoryConfig, cwd: string, githubToken?: string): Promise<string> {
    const repoPath = repoConfig.url
      .replace(/^.*github\.com\//, "")
      .replace(/\.git$/, "");
    const branch = await gh(
      ["pr", "view", String(prNumber), "--repo", repoPath, "--json", "headRefName", "--jq", ".headRefName"],
      cwd,
      githubToken
    );
    if (!branch) throw new Error(`PR #${prNumber} not found in ${repoPath}`);
    return branch;
  }

  /**
   * Post a comment on each pull request. Best-effort: logs errors, doesn't throw.
   */
  async commentOnPullRequestAll(
    baseDir: string,
    pullRequests: PullRequest[],
    comment: string,
    githubToken?: string,
  ): Promise<void> {
    for (const pr of pullRequests) {
      try {
        await gh(["pr", "comment", pr.url, "--body", comment], baseDir, githubToken);
      } catch (err) {
        console.error(
          `[git-manager] Failed to comment on PR ${pr.url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Create a pull request in all repos that are currently on the given branch.
   * Uses the `gh` CLI. If a PR already exists for the branch, retrieves its URL instead.
   * Returns successfully created/found PRs; failures are logged but not thrown.
   */
  async createPullRequestAll(
    baseDir: string,
    repos: RepositoryConfig[],
    branchName: string,
    title: string,
    body: string,
    draft = false,
    githubToken?: string,
  ): Promise<PullRequest[]> {
    const results: PullRequest[] = [];

    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);

      try {
        const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
        if (currentBranch !== branchName) continue;
      } catch {
        continue;
      }

      try {
        // Try to create a new PR
        const args = ["pr", "create", "--title", title, "--body", body, "--base", repo.defaultBranch, "--head", branchName];
        if (draft) args.push("--draft");
        const url = await gh(args, repoDir, githubToken);
        results.push({ repo: repo.name, url, state: draft ? "draft" : "open" });
      } catch (createErr) {
        // PR might already exist — try to get its URL and state
        try {
          const json = await gh(
            ["pr", "view", branchName, "--json", "url,state,isDraft"],
            repoDir,
            githubToken,
          );
          if (json) {
            const parsed = JSON.parse(json) as { url: string; state: string; isDraft: boolean };
            const rawState = parsed.state?.toUpperCase();
            let state: import("./types.js").PullRequestState;
            if (rawState === "MERGED") state = "merged";
            else if (rawState === "CLOSED") state = "closed";
            else state = parsed.isDraft ? "draft" : "open";
            results.push({ repo: repo.name, url: parsed.url, state });
          }
        } catch {
          console.error(`[git-manager] Failed to create PR for ${repo.name}: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
        }
      }
    }

    return results;
  }
}
