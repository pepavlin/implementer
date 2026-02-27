import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// Mock node:child_process before importing the module under test
vi.mock("node:child_process", () => ({
    spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { killStaleContainers } from "../src/executor.js";

/**
 * Build a fake ChildProcess whose stdout emits `stdout` and then closes
 * with `exitCode`. If `errorMsg` is set, it emits an "error" event instead.
 */
function makeMockProc(
    stdout = "",
    exitCode = 0,
    errorMsg?: string
): ChildProcess {
    const proc = new EventEmitter() as ChildProcess;
    (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (proc as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();

    setImmediate(() => {
        if (errorMsg) {
            proc.emit("error", new Error(errorMsg));
        } else {
            (proc as unknown as { stdout: EventEmitter }).stdout.emit(
                "data",
                Buffer.from(stdout)
            );
            proc.emit("close", exitCode);
        }
    });

    return proc;
}

describe("killStaleContainers", () => {
    const mockSpawn = vi.mocked(spawn);

    beforeEach(() => {
        vi.resetAllMocks();
        delete process.env.INSTANCE_NAME;
    });

    afterEach(() => {
        delete process.env.INSTANCE_NAME;
    });

    it("calls docker ps with the default instance name prefix", async () => {
        mockSpawn.mockReturnValueOnce(makeMockProc(""));

        await killStaleContainers();

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        expect(mockSpawn).toHaveBeenCalledWith(
            "docker",
            ["ps", "--filter", "name=implementer-", "--format", "{{.Names}}"],
            expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] })
        );
    });

    it("uses INSTANCE_NAME env var when set", async () => {
        process.env.INSTANCE_NAME = "my-custom-instance";
        mockSpawn.mockReturnValueOnce(makeMockProc(""));

        await killStaleContainers();

        expect(mockSpawn).toHaveBeenCalledWith(
            "docker",
            [
                "ps",
                "--filter",
                "name=my-custom-instance-",
                "--format",
                "{{.Names}}",
            ],
            expect.anything()
        );
    });

    it("does not call docker kill when no stale containers are found", async () => {
        mockSpawn.mockReturnValueOnce(makeMockProc(""));

        await killStaleContainers();

        // Only the `docker ps` call — no `docker kill`
        expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it("does not call docker kill when docker ps returns only whitespace", async () => {
        mockSpawn.mockReturnValueOnce(makeMockProc("   \n\n  "));

        await killStaleContainers();

        expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it("kills all listed containers when docker ps returns results", async () => {
        const containers = [
            "implementer-task1-abc123-0",
            "implementer-task2-def456-0",
        ];
        mockSpawn
            .mockReturnValueOnce(makeMockProc(containers.join("\n")))
            .mockReturnValueOnce(makeMockProc(""));

        await killStaleContainers();

        expect(mockSpawn).toHaveBeenCalledTimes(2);
        expect(mockSpawn).toHaveBeenNthCalledWith(
            2,
            "docker",
            ["kill", ...containers],
            expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] })
        );
    });

    it("handles a single stale container", async () => {
        mockSpawn
            .mockReturnValueOnce(makeMockProc("implementer-slug-abc-xyz123"))
            .mockReturnValueOnce(makeMockProc(""));

        await killStaleContainers();

        expect(mockSpawn).toHaveBeenNthCalledWith(
            2,
            "docker",
            ["kill", "implementer-slug-abc-xyz123"],
            expect.anything()
        );
    });

    it("resolves without throwing when docker ps errors", async () => {
        mockSpawn.mockReturnValueOnce(
            makeMockProc("", 0, "docker not found")
        );

        await expect(killStaleContainers()).resolves.toBeUndefined();
        // Should not attempt to kill
        expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it("resolves without throwing when docker kill errors", async () => {
        mockSpawn
            .mockReturnValueOnce(makeMockProc("implementer-task1-abc-0"))
            .mockReturnValueOnce(
                makeMockProc("", 0, "docker kill failed")
            );

        await expect(killStaleContainers()).resolves.toBeUndefined();
    });

    it("resolves without throwing when docker kill exits with non-zero", async () => {
        mockSpawn
            .mockReturnValueOnce(makeMockProc("implementer-task1-abc-0"))
            .mockReturnValueOnce(makeMockProc("", 1));

        await expect(killStaleContainers()).resolves.toBeUndefined();
    });

    it("trims trailing newline from docker ps output", async () => {
        const containers = [
            "implementer-task1-abc-0",
            "implementer-task2-def-0",
        ];
        // docker ps typically adds a trailing newline
        mockSpawn
            .mockReturnValueOnce(makeMockProc(containers.join("\n") + "\n"))
            .mockReturnValueOnce(makeMockProc(""));

        await killStaleContainers();

        expect(mockSpawn).toHaveBeenNthCalledWith(
            2,
            "docker",
            ["kill", ...containers],
            expect.anything()
        );
    });
});
