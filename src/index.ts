import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { validateConfigFile } from "./config.js";
import { TaskManager } from "./task-manager.js";
import { createServer } from "./server.js";

function ensureDockerImage(imageName: string, configPath: string | undefined) {
    // Check if the image already exists
    try {
        execFileSync("docker", ["image", "inspect", imageName], {
            stdio: "ignore"
        });
        console.log(`Docker image "${imageName}" found.`);
        return;
    } catch {
        // Image doesn't exist, need to build
    }

    const dockerfilePath = resolve(
        configPath ?? "config.yaml",
        "..",
        "Dockerfile.sandbox"
    );
    const contextDir = resolve(dockerfilePath, "..");

    console.log(
        `Docker image "${imageName}" not found. Building from ${dockerfilePath}...`
    );
    execFileSync(
        "docker",
        ["build", "-f", dockerfilePath, "-t", imageName, contextDir],
        {
            stdio: "inherit"
        }
    );
    console.log(`Docker image "${imageName}" built successfully.`);
}

async function main() {
    const configPath = process.argv[2] || undefined;

    console.log("Loading config...");
    const config = validateConfigFile(configPath);
    const projectIds = Object.keys(config.projects);
    console.log(
        `Config loaded. ${projectIds.length} project(s) configured: ${projectIds.join(", ")}`
    );

    const sandboxImage = process.env.SANDBOX_IMAGE || "implementer-sandbox";
    ensureDockerImage(sandboxImage, configPath);

    // Check gh CLI availability for PR creation
    try {
        execFileSync("gh", ["--version"], { stdio: "ignore" });
        console.log(
            "GitHub CLI (gh) found — pull requests will be created after tasks."
        );
    } catch {
        console.warn(
            "WARNING: GitHub CLI (gh) not found. Pull requests will NOT be created after tasks. Install gh and run 'gh auth login' to enable PR creation."
        );
    }

    const taskManager = new TaskManager(config);

    await taskManager.init();

    const app = createServer(taskManager, config);

    const port = Number(process.env.PORT) || 3000;
    app.listen(port, () => {
        console.log(`Implementer service running on port ${port}`);
        console.log(`Workspace directory: ${config.server.workspaceDir}`);
        console.log(`Docker image: ${sandboxImage}`);
        for (const [projectId, project] of Object.entries(config.projects)) {
            const repoNames = project.repositories
                .map((r) => r.name)
                .join(", ");
            console.log(`Project "${projectId}": ${repoNames}`);
        }
    });
}

main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
});
