/**
 * Claude Subscription Usage API client (reverse-engineered).
 *
 * Fetches subscription-level utilization data from the undocumented OAuth
 * usage endpoint that Claude Code itself uses internally.
 *
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 * Auth:     Bearer <OAuth access token> + anthropic-beta header
 *
 * Returns utilization percentages (0-100) for rolling rate-limit windows:
 *   - five_hour   — 5-hour rolling session limit
 *   - seven_day   — 7-day rolling weekly cap
 *   - seven_day_opus — Opus model 7-day usage (tracked separately)
 *
 * ⚠ This endpoint is aggressively rate-limited (~5 requests per token
 *   before permanent 429). Results are cached for 10 minutes to minimise
 *   API calls.
 *
 * @see https://codelynx.dev/posts/claude-code-usage-limits-statusline
 */

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_BETA = "oauth-2025-04-20";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes (aggressive caching to avoid 429)

// ── Types ────────────────────────────────────────────────────────────────────

/** A single utilization window from the API response. */
export interface UtilizationWindow {
    /** Usage percentage 0–100. */
    utilization: number;
    /** ISO 8601 datetime when this window resets, or null if not applicable. */
    resets_at: string | null;
}

/** Raw API response shape from GET /api/oauth/usage. */
export interface OAuthUsageResponse {
    five_hour?: UtilizationWindow | null;
    seven_day?: UtilizationWindow | null;
    seven_day_opus?: UtilizationWindow | null;
    /** Undocumented field – always null so far. */
    iguana_necktie?: unknown;
}

/** Processed subscription usage data for the dashboard. */
export interface SubscriptionUsage {
    fiveHour: {
        utilization: number;
        resetsAt: string | null;
    } | null;
    sevenDay: {
        utilization: number;
        resetsAt: string | null;
    } | null;
    sevenDayOpus: {
        utilization: number;
        resetsAt: string | null;
    } | null;
    fetchedAt: string;
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
    data: SubscriptionUsage;
    expiresAt: number;
}

let subscriptionCache: CacheEntry | null = null;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch subscription utilization data using an OAuth access token.
 *
 * @param oauthToken - A valid Claude Code OAuth access token (sk-ant-oat01-...)
 * @returns Processed subscription usage data
 * @throws Error on network failures or non-2xx responses
 */
export async function fetchSubscriptionUsage(
    oauthToken: string
): Promise<SubscriptionUsage> {
    // Return cached data if still valid
    if (subscriptionCache && subscriptionCache.expiresAt > Date.now()) {
        return subscriptionCache.data;
    }

    const response = await fetch(`${ANTHROPIC_API_BASE}/api/oauth/usage`, {
        headers: {
            Authorization: `Bearer ${oauthToken}`,
            "anthropic-beta": ANTHROPIC_BETA,
            "Content-Type": "application/json"
        }
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");

        // Special handling for rate limit errors
        if (response.status === 429) {
            // If we have stale cached data, return it with a note
            if (subscriptionCache) {
                return subscriptionCache.data;
            }
            throw new Error(
                "Subscription usage endpoint rate-limited (429). Try again later."
            );
        }

        throw new Error(
            `Subscription usage API error ${response.status}: ${body || response.statusText}`
        );
    }

    const raw = (await response.json()) as OAuthUsageResponse;

    const data: SubscriptionUsage = {
        fiveHour: raw.five_hour
            ? {
                  utilization: raw.five_hour.utilization,
                  resetsAt: raw.five_hour.resets_at
              }
            : null,
        sevenDay: raw.seven_day
            ? {
                  utilization: raw.seven_day.utilization,
                  resetsAt: raw.seven_day.resets_at
              }
            : null,
        sevenDayOpus: raw.seven_day_opus
            ? {
                  utilization: raw.seven_day_opus.utilization,
                  resetsAt: raw.seven_day_opus.resets_at
              }
            : null,
        fetchedAt: new Date().toISOString()
    };

    subscriptionCache = {
        data,
        expiresAt: Date.now() + CACHE_TTL_MS
    };

    return data;
}

/**
 * Clear the subscription usage cache.
 */
export function clearSubscriptionCache(): void {
    subscriptionCache = null;
}
