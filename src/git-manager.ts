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
   * Push the branch in all repos that have it checked out.
   */
  async pushBranchAll(baseDir: string, repos: RepositoryConfig[], branchName: string): Promise<void> {
    for (const repo of repos) {
      const repoDir = this.getRepoDir(baseDir, repo.name);

      // Check if this repo is on the branch
      try {
        const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
        if (currentBranch !== branchName) continue;
      } catch {
        continue;
      }

      // Check if there are commits to push (branch exists with commits ahead of default)
      try {
        await git(["push", "origin", branchName], repoDir);
      } catch {
        // May fail if nothing to push or no remote tracking
      }
    }
  }
}
