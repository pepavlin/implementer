import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export function getSandboxImageName() {
    return process.env.SANDBOX_IMAGE || "implementer-sandbox";
}

export function ensureAndPrepareDockerImage(
    imageName: string,
    configPath?: string
) {
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
