import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TokenManager } from "./auth.js";

const TMP = join(import.meta.dirname, "..", "tmp", "auth-test");

describe("TokenManager", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        delete process.env.CLAUDE_OAUTH_TOKEN;
        mkdirSync(TMP, { recursive: true });
    });

    afterEach(() => {
        process.env = { ...originalEnv };
        rmSync(TMP, { recursive: true, force: true });
    });

    it("uses CLAUDE_OAUTH_TOKEN env var as refresh-token source", async () => {
        process.env.CLAUDE_OAUTH_TOKEN = "refresh-from-new-env";
        const manager = new TokenManager(undefined, TMP);

        const refreshSpy = vi.spyOn(manager as any, "refreshAccessToken");
        refreshSpy.mockResolvedValue({
            accessToken: "access-token",
            refreshToken: "refresh-token-next",
            expiresAt: Date.now() + 3600_000
        });

        const credentials = await manager.getCredentials();

        expect(credentials.envName).toBe("CLAUDE_CODE_OAUTH_TOKEN");
        expect(credentials.value).toBe("access-token");
    });

    it("uses project-level claudeOauthToken field", async () => {
        const manager = new TokenManager(
            {
                claudeOauthToken: "oauth-from-config"
            },
            TMP
        );

        const refreshSpy = vi.spyOn(manager as any, "refreshAccessToken");
        refreshSpy.mockResolvedValue({
            accessToken: "access-from-project-token",
            refreshToken: "next-refresh-token",
            expiresAt: Date.now() + 3600_000
        });

        const credentials = await manager.getCredentials();

        expect(credentials.envName).toBe("CLAUDE_CODE_OAUTH_TOKEN");
        expect(credentials.value).toBe("access-from-project-token");
    });
});
