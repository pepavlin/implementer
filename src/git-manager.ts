import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RepositoryConfig } from "./types.js";

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`));
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
  async ensureAllRepos(baseDir: string, repos: RepositoryConfig[]): Promise<void> {
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }

    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);

      if (existsSync(join(repoDir, ".git"))) {
        await git(["fetch", "origin"], repoDir);
      } else {
        mkdirSync(repoDir, { recursive: true });
        await git(["clone", repo.url, repoDir], baseDir);
      }
    }
  }

  /**
   * Create a new branch from the default branch in all repos.
   */
  async prepareNewBranchAll(baseDir: string, repos: RepositoryConfig[], branchName: string): Promise<void> {
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);
      await git(["checkout", repo.defaultBranch], repoDir);
      await git(["pull", "origin", repo.defaultBranch], repoDir);
      await git(["checkout", "-b", branchName], repoDir);
    }
  }

  /**
   * Checkout an existing branch in all repos.
   */
  async checkoutBranchAll(baseDir: string, repos: RepositoryConfig[], branchName: string): Promise<void> {
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);
      await git(["fetch", "origin"], repoDir);

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
        await git(["pull", "origin", branchName], repoDir);
      } catch {
        // Branch may not exist on remote yet
      }
    }
  }

  /**
   * Reset all repos to their default branch and pull latest.
   */
  async resetToDefaultAll(baseDir: string, repos: RepositoryConfig[]): Promise<void> {
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);
      await git(["checkout", repo.defaultBranch], repoDir);
      await git(["pull", "origin", repo.defaultBranch], repoDir);
    }
  }

  /**
   * Check if any repo on the given branch has new commits ahead of the default branch.
   */
  async hasNewCommits(baseDir: string, repos: RepositoryConfig[], branchName: string): Promise<boolean> {
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);
      try {
        const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
        if (currentBranch !== branchName) continue;
        const log = await git(["log", `${repo.defaultBranch}..${branchName}`, "--oneline"], repoDir);
        if (log.length > 0) return true;
      } catch {
        continue;
      }
    }
    return false;
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
   * Push the branch in all repos that have new commits on it.
   * Returns true if any repo was pushed.
   */
  async pushBranchAll(baseDir: string, repos: RepositoryConfig[], branchName: string): Promise<boolean> {
    let pushed = false;
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);

      // Check if this repo is on the branch
      try {
        const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
        if (currentBranch !== branchName) continue;
      } catch {
        continue;
      }

      // Only push if there are new commits ahead of the default branch
      try {
        const log = await git(["log", `${repo.defaultBranch}..${branchName}`, "--oneline"], repoDir);
        if (log.length === 0) continue;
      } catch {
        continue;
      }

      try {
        await git(["push", "origin", branchName], repoDir);
        pushed = true;
      } catch {
        // May fail if no remote tracking
      }
    }
    return pushed;
  }
}
