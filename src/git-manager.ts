import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PullRequest, RepositoryConfig } from "./types.js";

function git(args: string[], cwd: string, githubToken?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // When a GitHub token is provided, inject it via http.extraHeader scoped
    // to github.com so HTTPS remotes authenticate without embedding credentials
    // in the URL or relying on shell-based credential helpers.
    const fullArgs = githubToken
      ? ["-c", `http.https://github.com/.extraHeader=Authorization: Bearer ${githubToken}`, ...args]
      : args;
    execFile("git", fullArgs, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
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
        await git(["fetch", "origin"], repoDir, githubToken);
      } else {
        mkdirSync(repoDir, { recursive: true });
        await git(["clone", repo.url, repoDir], baseDir, githubToken);
      }
    }
  }

  /**
   * Create a new branch from the default branch in all repos.
   */
  async prepareNewBranchAll(baseDir: string, repos: RepositoryConfig[], branchName: string, githubToken?: string): Promise<void> {
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);
      await git(["fetch", "origin"], repoDir, githubToken);
      await git(["checkout", repo.defaultBranch], repoDir);
      await git(["reset", "--hard", `origin/${repo.defaultBranch}`], repoDir);
      await git(["checkout", "-b", branchName], repoDir);
    }
  }

  /**
   * Checkout an existing branch in all repos.
   */
  async checkoutBranchAll(baseDir: string, repos: RepositoryConfig[], branchName: string, githubToken?: string): Promise<void> {
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);
      await git(["fetch", "origin"], repoDir, githubToken);

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

      try {
        await git(["pull", "origin", branchName], repoDir, githubToken);
      } catch {
        // Branch may not exist on remote yet
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
        results.push({ repo: repo.name, url });
      } catch (createErr) {
        // PR might already exist — try to get its URL
        try {
          const url = await gh(
            ["pr", "view", branchName, "--json", "url", "--jq", ".url"],
            repoDir,
            githubToken,
          );
          if (url) {
            results.push({ repo: repo.name, url });
          }
        } catch {
          console.error(`[git-manager] Failed to create PR for ${repo.name}: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
        }
      }
    }

    return results;
  }
}
