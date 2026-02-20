import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { UsageLimiter, UsageLimitError } from "./usage-limiter.js";
import type { TokenManager } from "./auth.js";

const TMP = join(import.meta.dirname, "..", "tmp", "usage-limiter-test");

function makeTokenManager(
    envName: "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN",
    value = "test-token"
) {
    return {
        getCredentials: vi.fn().mockResolvedValue({ envName, value })
    } as unknown as TokenManager;
}

describe("UsageLimiter", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        mkdirSync(TMP, { recursive: true });
    });

    afterEach(() => {
        rmSync(TMP, { recursive: true, force: true });
        globalThis.fetch = originalFetch;
    });

    it("is a no-op when using ANTHROPIC_API_KEY (not OAuth)", async () => {
        const tm = makeTokenManager("ANTHROPIC_API_KEY");
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy;

        const limiter = new UsageLimiter(100_000, tm);
        await expect(limiter.checkLimit()).resolves.toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("does not throw when usage is below the limit", async () => {
        const tm = makeTokenManager("CLAUDE_CODE_OAUTH_TOKEN", "oauth-access");
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ used: 50_000 })
        } as Response);

        const limiter = new UsageLimiter(100_000, tm);
        await expect(limiter.checkLimit()).resolves.toBeUndefined();
    });

    it("throws UsageLimitError when usage exceeds the limit", async () => {
        const tm = makeTokenManager("CLAUDE_CODE_OAUTH_TOKEN", "oauth-access");
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ used: 150_000 })
        } as Response);

        const limiter = new UsageLimiter(100_000, tm);
        await expect(limiter.checkLimit()).rejects.toThrow(UsageLimitError);
        await expect(limiter.checkLimit()).rejects.toThrow(
            "Token usage limit exceeded"
        );
    });

    it("is non-fatal when the usage API returns an error", async () => {
        const tm = makeTokenManager("CLAUDE_CODE_OAUTH_TOKEN", "oauth-access");
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: async () => "Internal Server Error"
        } as Response);

        const limiter = new UsageLimiter(100_000, tm);
        // Should resolve (not throw) — API errors are logged but non-fatal
        await expect(limiter.checkLimit()).resolves.toBeUndefined();
    });

    it("is non-fatal when fetch itself throws a network error", async () => {
        const tm = makeTokenManager("CLAUDE_CODE_OAUTH_TOKEN", "oauth-access");
        globalThis.fetch = vi
            .fn()
            .mockRejectedValue(new Error("Network error"));

        const limiter = new UsageLimiter(100_000, tm);
        await expect(limiter.checkLimit()).resolves.toBeUndefined();
    });

    it("caches the usage response for 60 seconds", async () => {
        const tm = makeTokenManager("CLAUDE_CODE_OAUTH_TOKEN", "oauth-access");
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ used: 10_000 })
        } as Response);
        globalThis.fetch = fetchMock;

        const limiter = new UsageLimiter(100_000, tm);
        await limiter.checkLimit();
        await limiter.checkLimit();
        await limiter.checkLimit();

        // Should have only fetched once due to cache
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("parses nested 'usage' field in response", async () => {
        const tm = makeTokenManager("CLAUDE_CODE_OAUTH_TOKEN", "oauth-access");
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ usage: { used: 120_000 } })
        } as Response);

        const limiter = new UsageLimiter(100_000, tm);
        await expect(limiter.checkLimit()).rejects.toThrow(UsageLimitError);
    });

    it("parses totalTokensUsed field in response", async () => {
        const tm = makeTokenManager("CLAUDE_CODE_OAUTH_TOKEN", "oauth-access");
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ totalTokensUsed: 200_000 })
        } as Response);

        const limiter = new UsageLimiter(50_000, tm);
        await expect(limiter.checkLimit()).rejects.toThrow(UsageLimitError);
    });

    it("passes through without error when response has no known fields", async () => {
        const tm = makeTokenManager("CLAUDE_CODE_OAUTH_TOKEN", "oauth-access");
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ someUnknownField: "hello" })
        } as Response);

        const limiter = new UsageLimiter(100_000, tm);
        // Returns 0 for unknown format → 0 < 100000 → no error
        await expect(limiter.checkLimit()).resolves.toBeUndefined();
    });
});
