import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { TaskManager } from "./task-manager.js";
import { createServer } from "./server.js";
import { TokenManager } from "./auth.js";

function ensureDockerImage(imageName: string, configPath: string | undefined) {
  // Check if the image already exists
  try {
    execFileSync("docker", ["image", "inspect", imageName], { stdio: "ignore" });
    console.log(`Docker image "${imageName}" found.`);
    return;
  } catch {
    // Image doesn't exist, need to build
  }

  const dockerfilePath = resolve(configPath ?? "config.yaml", "..", "Dockerfile.sandbox");
  const contextDir = resolve(dockerfilePath, "..");

  console.log(`Docker image "${imageName}" not found. Building from ${dockerfilePath}...`);
  execFileSync("docker", ["build", "-f", dockerfilePath, "-t", imageName, contextDir], {
    stdio: "inherit",
  });
  console.log(`Docker image "${imageName}" built successfully.`);
}

async function main() {
  const configPath = process.argv[2] || undefined;

  console.log("Loading config...");
  const config = loadConfig(configPath);
  console.log(`Config loaded. ${config.repositories.length} repository(ies) configured.`);

  const sandboxImage = process.env.SANDBOX_IMAGE || "implementer-sandbox";
  ensureDockerImage(sandboxImage, configPath);

  const tokenManager = new TokenManager(config.server.workspaceDir);
  const taskManager = new TaskManager(config, tokenManager);

  await taskManager.init();

  const app = createServer(taskManager);

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Implementer service running on port ${port}`);
    console.log(`Workspace directory: ${config.server.workspaceDir}`);
    console.log(`Docker image: ${sandboxImage}`);
    console.log(`Repositories: ${config.repositories.map((r) => r.name).join(", ")}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
