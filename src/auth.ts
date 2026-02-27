import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import type { ProjectAuth } from "./config/config-types.js";

const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Refresh 5 minutes before actual expiry to avoid race conditions
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface TokenCache {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

interface TokenResult {
    envName: string;
    value: string;
}

/**
 * Manages Claude Code authentication credentials.
 *
 * Supports these modes (checked in order):
 *   1. Project-level API key (from ProjectAuth)
 *   2. Global ANTHROPIC_API_KEY env var
 *   3. OAuth with auto-refresh – project-level or global refresh token
 *   4. Static global OAuth token (no refresh – will expire)
 *   5. macOS Keychain fallback – dev-only, reads tokens from local keychain
 */
export class TokenManager {
    private cache: TokenCache | null = null;
    private cacheFile: string;
    private auth: ProjectAuth | undefined;

    constructor(auth: ProjectAuth | undefined, cacheDir: string) {
        this.auth = auth;
        this.cacheFile = resolve(cacheDir, ".claude-token-cache.json");
    }

    /**
     * Get valid credentials for passing to a Docker container.
     * Automatically refreshes OAuth tokens when needed.
     */
    async getCredentials(): Promise<TokenResult> {
        // 1. Project-level API key
        if (this.auth?.anthropicApiKey) {
            return {
                envName: "ANTHROPIC_API_KEY",
                value: this.auth.anthropicApiKey
            };
        }

        // 2. Global API key (never expires)
        if (process.env.ANTHROPIC_API_KEY) {
            return {
                envName: "ANTHROPIC_API_KEY",
                value: process.env.ANTHROPIC_API_KEY
            };
        }

        // 3. OAuth with auto-refresh (project-level or global)
        const refreshToken = this.getRefreshToken();
        if (refreshToken) {
            const accessToken = await this.getValidAccessToken(refreshToken);
            return { envName: "CLAUDE_CODE_OAUTH_TOKEN", value: accessToken };
        }

        // 4. Static OAuth token from config (no refresh – will expire in ~1h)
        if (this.auth?.claudeOauthToken) {
            console.warn(
                "Warning: Using static OAuth token from config without refresh token. It will expire in ~1h."
            );
            return {
                envName: "CLAUDE_CODE_OAUTH_TOKEN",
                value: this.auth.claudeOauthToken
            };
        }

        // 5. Static OAuth token from env (no refresh – will expire)
        if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
            console.warn(
                "Warning: Using static OAuth token without refresh token. It will expire in ~1h."
            );
            return {
                envName: "CLAUDE_CODE_OAUTH_TOKEN",
                value: process.env.CLAUDE_CODE_OAUTH_TOKEN
            };
        }

        // 6. macOS Keychain fallback (dev only)
        return this.fromKeychain();
    }

    private getRefreshToken(): string | null {
        // Disk cache first — it has the most recent refresh token after a refresh cycle
        // (refresh tokens are single-use, so the initial seed becomes stale after first refresh)
        const cached = this.loadCache();
        if (cached?.refreshToken) {
            return cached.refreshToken;
        }

        // Project-level OAuth refresh token as initial seed
        if (this.auth?.claudeOauthRefreshToken) {
            return this.auth.claudeOauthRefreshToken;
        }

        // Global env var as initial seed (used on first-ever start)
        if (process.env.CLAUDE_OAUTH_TOKEN) {
            return process.env.CLAUDE_OAUTH_TOKEN;
        }

        return null;
    }

    private async getValidAccessToken(refreshToken: string): Promise<string> {
        // Check memory cache first
        if (
            this.cache &&
            Date.now() < this.cache.expiresAt - EXPIRY_BUFFER_MS
        ) {
            return this.cache.accessToken;
        }

        // Check disk cache
        const diskCache = this.loadCache();
        if (diskCache && Date.now() < diskCache.expiresAt - EXPIRY_BUFFER_MS) {
            this.cache = diskCache;
            return diskCache.accessToken;
        }

        // Try refreshing with the most recent token first, fall back to env seed
        const candidates = [
            diskCache?.refreshToken,
            refreshToken,
            process.env.CLAUDE_OAUTH_TOKEN
        ].filter((t): t is string => !!t);

        // Deduplicate while preserving order
        const unique = [...new Set(candidates)];

        for (const token of unique) {
            try {
                console.log("Refreshing OAuth access token...");
                const result = await this.refreshAccessToken(token);
                this.cache = result;
                this.saveCache(result);
                console.log(
                    `OAuth token refreshed. Expires at ${new Date(result.expiresAt).toISOString()}`
                );
                return result.accessToken;
            } catch (err) {
                console.warn(
                    `Refresh attempt failed: ${err instanceof Error ? err.message : err}`
                );
            }
        }

        throw new Error(
            "All OAuth refresh attempts failed. Generate a new refresh token with: claude setup-token"
        );
    }

    private async refreshAccessToken(
        refreshToken: string
    ): Promise<TokenCache> {
        const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: CLIENT_ID
        });

        const response = await fetch(OAUTH_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString()
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `OAuth refresh failed (${response.status}): ${text}`
            );
        }

        const data = (await response.json()) as {
            access_token: string;
            refresh_token?: string;
            expires_in?: number;
        };

        return {
            accessToken: data.access_token,
            // Use new refresh token if provided, otherwise keep the old one
            refreshToken: data.refresh_token ?? refreshToken,
            expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000
        };
    }

    private loadCache(): TokenCache | null {
        try {
            const raw = readFileSync(this.cacheFile, "utf-8");
            return JSON.parse(raw) as TokenCache;
        } catch {
            return null;
        }
    }

    private saveCache(cache: TokenCache): void {
        try {
            mkdirSync(dirname(this.cacheFile), { recursive: true });
            writeFileSync(
                this.cacheFile,
                JSON.stringify(cache, null, 2),
                "utf-8"
            );
        } catch (err) {
            console.warn("Warning: Could not persist token cache:", err);
        }
    }

    private fromKeychain(): TokenResult {
        try {
            const creds = execFileSync(
                "security",
                [
                    "find-generic-password",
                    "-s",
                    "Claude Code-credentials",
                    "-w"
                ],
                { encoding: "utf-8" }
            ).trim();

            const parsed = JSON.parse(creds);
            const token = parsed.claudeAiOauth?.accessToken ?? "";
            return { envName: "CLAUDE_CODE_OAUTH_TOKEN", value: token };
        } catch {
            throw new Error(
                "Could not retrieve Claude credentials. Set ANTHROPIC_API_KEY, or CLAUDE_OAUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN."
            );
        }
    }
}
