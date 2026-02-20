import type { TokenManager } from "./auth.js";

const USAGE_API_URL = "https://api.anthropic.com/api/oauth/usage";

/**
 * Thrown when the token/hour usage limit is exceeded.
 * Results in a 429 response to the caller.
 */
export class UsageLimitError extends Error {
    constructor(
        public readonly usedTokens: number,
        public readonly maxTokensPerHour: number
    ) {
        super(
            `Token usage limit exceeded: ${usedTokens.toLocaleString()} tokens used this period, limit is ${maxTokensPerHour.toLocaleString()} tokens/hour`
        );
        this.name = "UsageLimitError";
    }
}

interface UsageCache {
    usedTokens: number;
    fetchedAt: number;
}

/**
 * Checks token usage via the Anthropic OAuth usage API before starting a task.
 *
 * Calls GET https://api.anthropic.com/api/oauth/usage with the project's OAuth
 * access token and compares the result against the configured `maxTokensPerHour`
 * limit. The response is cached for 60 seconds to avoid excessive API calls.
 *
 * Only active when using OAuth-based authentication (not API key mode).
 * API errors are non-fatal: a warning is logged and the task is allowed through.
 */
export class UsageLimiter {
    private readonly maxTokensPerHour: number;
    private readonly tokenManager: TokenManager;
    private cache: UsageCache | null = null;
    private readonly CACHE_TTL_MS = 60_000;

    constructor(maxTokensPerHour: number, tokenManager: TokenManager) {
        this.maxTokensPerHour = maxTokensPerHour;
        this.tokenManager = tokenManager;
    }

    /**
     * Check whether the current token usage is below the configured limit.
     * Throws UsageLimitError if the limit is exceeded.
     * No-op when using API key authentication (usage API requires OAuth).
     */
    async checkLimit(): Promise<void> {
        const credentials = await this.tokenManager.getCredentials();

        // Usage API only works with OAuth access tokens, not API keys
        if (credentials.envName !== "CLAUDE_CODE_OAUTH_TOKEN") {
            return;
        }

        let usedTokens: number;
        try {
            usedTokens = await this.fetchUsage(credentials.value);
        } catch (err) {
            console.warn(
                `[usage-limiter] Could not fetch usage data, skipping limit check: ${err instanceof Error ? err.message : err}`
            );
            return;
        }

        if (usedTokens > this.maxTokensPerHour) {
            throw new UsageLimitError(usedTokens, this.maxTokensPerHour);
        }

        console.log(
            `[usage-limiter] Token usage: ${usedTokens.toLocaleString()} / ${this.maxTokensPerHour.toLocaleString()}`
        );
    }

    private async fetchUsage(accessToken: string): Promise<number> {
        // Return cached value if still fresh
        if (
            this.cache &&
            Date.now() - this.cache.fetchedAt < this.CACHE_TTL_MS
        ) {
            return this.cache.usedTokens;
        }

        const response = await fetch(USAGE_API_URL, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!response.ok) {
            throw new Error(
                `Usage API returned ${response.status}: ${await response.text()}`
            );
        }

        const data: unknown = await response.json();
        const usedTokens = extractTokenCount(data);
        this.cache = { usedTokens, fetchedAt: Date.now() };
        return usedTokens;
    }
}

/**
 * Extract a token count from the usage API response.
 * Tries multiple field names and nested structures since the exact format is
 * not publicly documented. Logs the full response on the first unknown format
 * so operators can identify the correct field.
 */
function extractTokenCount(data: unknown): number {
    if (!data || typeof data !== "object") return 0;
    const d = data as Record<string, unknown>;

    // Flat numeric fields — try common naming patterns
    const candidateFields = [
        "totalTokensUsed",
        "tokens_used",
        "used_tokens",
        "used",
        "tokensUsed",
        "total_used",
        "totalUsed",
        "inputTokens",
        "input_tokens",
        "total_tokens",
        "totalTokens"
    ];

    for (const field of candidateFields) {
        if (typeof d[field] === "number") {
            return d[field] as number;
        }
    }

    // Try one level of nesting under "usage", "tokens", "data"
    for (const wrapper of ["usage", "tokens", "data"]) {
        if (d[wrapper] && typeof d[wrapper] === "object") {
            const nested = extractTokenCount(d[wrapper]);
            if (nested > 0) return nested;
        }
    }

    // Unknown format — log the full response so operators can report the shape
    console.warn(
        "[usage-limiter] Unknown usage API response format. Please report the structure so the parser can be updated:\n" +
            JSON.stringify(data, null, 2)
    );
    return 0;
}
