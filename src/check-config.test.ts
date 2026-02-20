import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runConfigCheck } from "./check-config.js";

const TMP = join(import.meta.dirname, "..", "tmp", "check-config-test");

function writeYaml(filename: string, content: string): string {
    const path = join(TMP, filename);
    writeFileSync(path, content);
    return path;
}

describe("runConfigCheck", () => {
    let originalCwd = "";

    beforeEach(() => {
        originalCwd = process.cwd();
        mkdirSync(TMP, { recursive: true });
    });

    afterEach(() => {
        process.chdir(originalCwd);
        rmSync(TMP, { recursive: true, force: true });
    });

    it("returns 0 for valid multi-project config", () => {
        const path = writeYaml(
            "valid.yaml",
            `
projects:
  project-a:
    repositories:
      - name: repo-a
        url: https://github.com/test/repo-a.git
  project-b:
    repositories:
      - name: repo-b
        url: https://github.com/test/repo-b.git
`
        );

        const logger = {
            log: vi.fn(),
            error: vi.fn()
        };

        const exitCode = runConfigCheck(path, logger);
        expect(exitCode).toBe(0);
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.log).toHaveBeenCalledWith(
            expect.stringContaining("Config is valid. 2 project(s) configured")
        );
    });

    it("returns 1 for invalid config", () => {
        const path = writeYaml(
            "invalid.yaml",
            `
projects:
  my-project:
    repositories: []
`
        );

        const logger = {
            log: vi.fn(),
            error: vi.fn()
        };

        const exitCode = runConfigCheck(path, logger);
        expect(exitCode).toBe(1);
        expect(logger.log).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("Config validation failed")
        );
    });

    it("uses config.yaml by default", () => {
        writeYaml(
            "config.yaml",
            `
projects:
  my-project:
    repositories:
      - name: repo
        url: https://github.com/test/repo.git
`
        );
        process.chdir(TMP);

        const logger = {
            log: vi.fn(),
            error: vi.fn()
        };

        const exitCode = runConfigCheck(undefined, logger);
        expect(exitCode).toBe(0);
        expect(logger.error).not.toHaveBeenCalled();
    });
});
