import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { Config } from "./types.js";

const ServerSchema = z.object({
  port: z.number().int().positive().default(3000),
  workspaceDir: z.string().default("./workspace"),
});

const RepositorySchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  defaultBranch: z.string().default("main"),
});

const McpServerSchema = z.object({
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
});

const ClaudeCodeSchema = z.object({
  command: z.string().default("claude"),
  model: z.string().optional(),
  dockerImage: z.string().default("implementer-sandbox"),
  systemPrompt: z.string().optional(),
  mcpServers: z.record(McpServerSchema).optional(),
});

const ConfigSchema = z.object({
  server: ServerSchema.default({}),
  repositories: z.array(RepositorySchema).min(1),
  claudeCode: ClaudeCodeSchema.default({}),
});

export function loadConfig(configPath?: string): Config {
  const resolvedPath = resolve(configPath ?? "config.yaml");
  const raw = readFileSync(resolvedPath, "utf-8");
  const parsed = yaml.load(raw);
  const validated = ConfigSchema.parse(parsed);

  // Resolve workspaceDir to absolute path relative to config file location
  validated.server.workspaceDir = resolve(
    resolvedPath,
    "..",
    validated.server.workspaceDir
  );

  return validated;
}
