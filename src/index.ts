import { execFileSync } from "node:child_process";
import { Config } from "./config/config.js";
import { TaskManager } from "./task-manager/task-manager.js";
import { createServer } from "./server.js";
import { ensureAndPrepareDockerImage, getSandboxImageName } from "./docker.js";
import { exit } from "node:process";

function checkGitHubCLI() {
    try {
        execFileSync("gh", ["--version"], { stdio: "ignore" });
        console.log(
            "GitHub CLI (gh) found — pull requests will be created after tasks."
        );
    } catch {
        console.warn("WARNING: GitHub CLI (gh) not found. ");
        exit(1);
    }
}

async function main() {
    // 1. Load config
    const config = Config.load();

    // 2. Prepare sandbox Docker image
    ensureAndPrepareDockerImage(getSandboxImageName(), config.configPath);

    // 3. Check for GitHub CLI
    checkGitHubCLI();

    // 4. Initialize Task Manager
    const taskManager = new TaskManager(config);
    await taskManager.init();

    // 5. Start API server
    const app = createServer(taskManager, config);
    const port = Number(process.env.PORT) || 3000;
    app.listen(port, () => {
        console.log(`Implementer service running on port ${port}`);
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
