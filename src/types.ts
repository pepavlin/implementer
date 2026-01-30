export interface ServerConfig {
  port: number;
  workspaceDir: string;
}

export interface RepositoryConfig {
  name: string;
  url: string;
  defaultBranch: string;
  allowedTools: string[];
}

export interface ClaudeCodeConfig {
  command: string;
  maxTurns: number;
  model?: string;
}

export interface Config {
  server: ServerConfig;
  repositories: RepositoryConfig[];
  claudeCode: ClaudeCodeConfig;
}

export type TaskStatus = "idle" | "running" | "completed" | "failed";

export interface Task {
  taskId: string;
  repository: string;
  branch: string;
  prompt: string;
  status: TaskStatus;
  startedAt: string;
  completedAt: string | null;
  output: string;
  error?: string;
}

export interface TaskCreateRequest {
  repository: string;
  prompt: string;
  fromBranch?: string;
}

export interface TaskCreateResponse {
  taskId: string;
  repository: string;
  branch: string;
  status: TaskStatus;
}

export interface TaskStatusResponse {
  taskId: string;
  repository: string;
  branch: string;
  prompt: string;
  status: TaskStatus;
  startedAt: string;
  completedAt: string | null;
}

export interface IdleStatusResponse {
  status: "idle";
  lastTask: TaskStatusResponse | null;
}

export interface TaskLogResponse {
  taskId: string;
  output: string;
  truncated: boolean;
}

export interface ErrorResponse {
  error: string;
  currentTask?: {
    taskId: string;
    status: TaskStatus;
  };
}
