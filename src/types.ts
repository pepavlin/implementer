export interface ServerConfig {
  port: number;
  workspaceDir: string;
}

export interface RepositoryConfig {
  name: string;
  url: string;
  defaultBranch: string;
}

export interface ClaudeCodeConfig {
  command: string;
  model?: string;
  dockerImage: string;
}

export interface Config {
  server: ServerConfig;
  repositories: RepositoryConfig[];
  claudeCode: ClaudeCodeConfig;
}

export type TaskStatus = "running" | "completed" | "failed";

export interface Task {
  taskId: string;
  branch: string | null;
  prompt: string;
  status: TaskStatus;
  startedAt: string;
  completedAt: string | null;
  output: string;
  error?: string;
}

export interface TaskCreateRequest {
  prompt: string;
  fromBranch?: string;
}
