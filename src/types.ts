export interface ServerConfig {
  port: number;
  workspaceDir: string;
}

export interface RepositoryConfig {
  name: string;
  url: string;
  defaultBranch: string;
}

export interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface ClaudeCodeConfig {
  command: string;
  model?: string;
  dockerImage: string;
  systemPrompt?: string;
  mcpServers?: Record<string, McpServerConfig>;
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
