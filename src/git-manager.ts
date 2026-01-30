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
  private workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    if (!existsSync(workspaceDir)) {
      mkdirSync(workspaceDir, { recursive: true });
    }
  }

  getRepoDir(repoName: string): string {
    return join(this.workspaceDir, repoName);
  }

  /**
   * Ensure the repo is cloned. If already cloned, fetch latest.
   */
  async ensureRepo(repo: RepositoryConfig): Promise<string> {
    const repoDir = this.getRepoDir(repo.name);

    if (existsSync(join(repoDir, ".git"))) {
      await git(["fetch", "origin"], repoDir);
    } else {
      mkdirSync(repoDir, { recursive: true });
      await git(
        ["clone", repo.url, repoDir],
        this.workspaceDir
      );
    }

    return repoDir;
  }

  /**
   * Prepare a new branch from the default branch.
   * Checks out defaultBranch, pulls, then creates the given branch.
   */
  async prepareNewBranch(repo: RepositoryConfig, branchName: string): Promise<void> {
    const repoDir = this.getRepoDir(repo.name);

    await git(["checkout", repo.defaultBranch], repoDir);
    await git(["pull", "origin", repo.defaultBranch], repoDir);
    await git(["checkout", "-b", branchName], repoDir);
  }

  /**
   * Checkout an existing branch for continuation.
   * Fetches and pulls if the branch exists on remote.
   */
  async checkoutBranch(repo: RepositoryConfig, branchName: string): Promise<void> {
    const repoDir = this.getRepoDir(repo.name);

    await git(["fetch", "origin"], repoDir);

    // Try to check out the branch - it may be local or remote
    try {
      await git(["checkout", branchName], repoDir);
    } catch {
      // Branch might only exist on remote
      await git(["checkout", "-b", branchName, `origin/${branchName}`], repoDir);
    }

    // Try to pull latest (may fail if no upstream tracking)
    try {
      await git(["pull", "origin", branchName], repoDir);
    } catch {
      // Branch may not exist on remote yet, that's fine
    }
  }

  /**
   * Push the current branch to origin.
   */
  async pushBranch(repoName: string, branchName: string): Promise<void> {
    const repoDir = this.getRepoDir(repoName);
    await git(["push", "origin", branchName], repoDir);
  }
}
