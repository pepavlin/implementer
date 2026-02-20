import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfigFile } from "./config.js";

type Logger = Pick<Console, "log" | "error">;

export function runConfigCheck(
    configPathArg?: string,
    logger: Logger = console
): number {
    const resolvedPath = resolve(configPathArg ?? "config.yaml");

    try {
        const config = validateConfigFile(resolvedPath);
        const projectIds = Object.keys(config.projects);
        logger.log(
            `Config is valid. ${projectIds.length} project(s) configured: ${projectIds.join(", ")}`
        );
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
            `Config validation failed for ${resolvedPath}: ${message}`
        );
        return 1;
    }
}

if (
    process.argv[1] &&
    fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
    process.exit(runConfigCheck(process.argv[2]));
}
