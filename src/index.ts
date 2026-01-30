import { loadConfig } from "./config.js";
import { TaskManager } from "./task-manager.js";
import { createServer } from "./server.js";

function main() {
  const configPath = process.argv[2] || undefined;

  console.log("Loading config...");
  const config = loadConfig(configPath);
  console.log(`Config loaded. ${config.repositories.length} repository(ies) configured.`);

  const taskManager = new TaskManager(config);
  const app = createServer(config, taskManager);

  app.listen(config.server.port, () => {
    console.log(`Implementer service running on port ${config.server.port}`);
    console.log(`Workspace directory: ${config.server.workspaceDir}`);
    console.log(`Claude Code command: ${config.claudeCode.command}`);
    console.log(`Repositories: ${config.repositories.map((r) => r.name).join(", ")}`);
  });
}

main();
