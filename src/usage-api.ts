/**
 * Anthropic Usage & Cost API client.
 *
 * Fetches organization-level usage and cost data from the Anthropic Admin API.
 * Requires an Admin API key (sk-ant-admin...) configured in server.anthropicAdminApiKey.
 *
 * Endpoints used:
 *   GET /v1/organizations/usage_report/messages — token consumption by model
 *   GET /v1/organizations/cost_report            — cost breakdown in USD
 *
 * Results are cached in-memory for 5 minutes to avoid excessive polling.
 *
 * @see https://platform.claude.com/docs/en/build-with-claude/usage-cost-api
 */

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Types ────────────────────────────────────────────────────────────────────

export interface UsageBucket {
    snapshot_at: string;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    model?: string;
    api_key_id?: string | null;
    workspace_id?: string | null;
}

export interface UsageReportResponse {
    data: UsageBucket[];
    has_more: boolean;
    next_page?: string;
}

export interface CostBucket {
    snapshot_at: string;
    amount_cents: string; // decimal string
    workspace_id?: string | null;
    description?: string | null;
    model?: string | null;
}

export interface CostReportResponse {
    data: CostBucket[];
    has_more: boolean;
    next_page?: string;
}

/** Aggregated per-model usage summary for the dashboard. */
export interface ModelUsageSummary {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
}

/** Aggregated cost item for the dashboard. */
export interface CostSummary {
    description: string;
    amountCents: number;
}

/** Combined usage + cost response for the dashboard API. */
export interface UsageDashboardData {
    period: string;
    startingAt: string;
    endingAt: string;
    models: ModelUsageSummary[];
    costs: CostSummary[];
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheCreationTokens: number;
    totalCacheReadTokens: number;
    totalTokens: number;
    totalCostCents: number;
    fetchedAt: string;
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
    data: UsageDashboardData;
    expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildUrl(
    path: string,
    params: Record<string, string | string[]>
): string {
    const url = new URL(path, ANTHROPIC_API_BASE);
    for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) {
            for (const v of value) {
                url.searchParams.append(key, v);
            }
        } else {
            url.searchParams.set(key, value);
        }
    }
    return url.toString();
}

async function fetchAnthropicApi<T>(
    adminApiKey: string,
    path: string,
    params: Record<string, string | string[]>
): Promise<T> {
    const url = buildUrl(path, params);
    const response = await fetch(url, {
        headers: {
            "x-api-key": adminApiKey,
            "anthropic-version": ANTHROPIC_VERSION
        }
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
            `Anthropic API error ${response.status}: ${body || response.statusText}`
        );
    }

    return response.json() as Promise<T>;
}

/**
 * Fetch all pages of a paginated Anthropic API response.
 */
async function fetchAllPages<T extends { data: unknown[]; has_more: boolean; next_page?: string }>(
    adminApiKey: string,
    path: string,
    params: Record<string, string | string[]>,
    maxPages = 10
): Promise<T["data"]> {
    const allData: unknown[] = [];
    let currentParams = { ...params };
    let pages = 0;

    while (pages < maxPages) {
        const response = await fetchAnthropicApi<T>(
            adminApiKey,
            path,
            currentParams
        );
        allData.push(...response.data);
        pages++;

        if (!response.has_more || !response.next_page) break;
        currentParams = { ...params, page: response.next_page };
    }

    return allData as T["data"];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get date range for the specified period.
 */
function getDateRange(period: string): { startingAt: string; endingAt: string } {
    const now = new Date();
    const endingAt = now.toISOString();
    const start = new Date(now);

    switch (period) {
        case "7d":
            start.setDate(start.getDate() - 7);
            break;
        case "30d":
            start.setDate(start.getDate() - 30);
            break;
        case "24h":
            start.setHours(start.getHours() - 24);
            break;
        default:
            start.setDate(start.getDate() - 7);
    }

    return { startingAt: start.toISOString(), endingAt };
}

/**
 * Fetch usage and cost data from Anthropic API, with caching.
 *
 * @param adminApiKey - Anthropic Admin API key
 * @param period - Time period: "24h", "7d", or "30d"
 * @returns Aggregated usage and cost data
 */
export async function fetchUsageData(
    adminApiKey: string,
    period: string = "7d"
): Promise<UsageDashboardData> {
    const cacheKey = `usage:${period}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
    }

    const { startingAt, endingAt } = getDateRange(period);
    const bucketWidth = period === "24h" ? "1h" : "1d";

    // Fetch usage grouped by model
    const usageData = await fetchAllPages<UsageReportResponse>(
        adminApiKey,
        "/v1/organizations/usage_report/messages",
        {
            starting_at: startingAt,
            ending_at: endingAt,
            bucket_width: bucketWidth,
            "group_by[]": "model"
        }
    );

    // Fetch cost data grouped by description (includes model)
    const costData = await fetchAllPages<CostReportResponse>(
        adminApiKey,
        "/v1/organizations/cost_report",
        {
            starting_at: startingAt,
            ending_at: endingAt,
            "group_by[]": "description"
        }
    );

    // Aggregate usage by model
    const modelMap = new Map<string, ModelUsageSummary>();
    for (const bucket of usageData as UsageBucket[]) {
        const model = bucket.model || "unknown";
        const existing = modelMap.get(model);
        if (existing) {
            existing.inputTokens += bucket.input_tokens;
            existing.outputTokens += bucket.output_tokens;
            existing.cacheCreationTokens += bucket.cache_creation_input_tokens;
            existing.cacheReadTokens += bucket.cache_read_input_tokens;
            existing.totalTokens +=
                bucket.input_tokens +
                bucket.output_tokens +
                bucket.cache_creation_input_tokens +
                bucket.cache_read_input_tokens;
        } else {
            modelMap.set(model, {
                model,
                inputTokens: bucket.input_tokens,
                outputTokens: bucket.output_tokens,
                cacheCreationTokens: bucket.cache_creation_input_tokens,
                cacheReadTokens: bucket.cache_read_input_tokens,
                totalTokens:
                    bucket.input_tokens +
                    bucket.output_tokens +
                    bucket.cache_creation_input_tokens +
                    bucket.cache_read_input_tokens
            });
        }
    }

    // Sort models by total tokens descending
    const models = Array.from(modelMap.values()).sort(
        (a, b) => b.totalTokens - a.totalTokens
    );

    // Aggregate costs
    const costMap = new Map<string, number>();
    for (const bucket of costData as CostBucket[]) {
        const desc = bucket.description || "Other";
        const cents = parseFloat(bucket.amount_cents) || 0;
        costMap.set(desc, (costMap.get(desc) || 0) + cents);
    }
    const costs: CostSummary[] = Array.from(costMap.entries())
        .map(([description, amountCents]) => ({ description, amountCents }))
        .sort((a, b) => b.amountCents - a.amountCents);

    // Compute totals
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;
    for (const m of models) {
        totalInputTokens += m.inputTokens;
        totalOutputTokens += m.outputTokens;
        totalCacheCreationTokens += m.cacheCreationTokens;
        totalCacheReadTokens += m.cacheReadTokens;
    }
    const totalTokens =
        totalInputTokens +
        totalOutputTokens +
        totalCacheCreationTokens +
        totalCacheReadTokens;

    const totalCostCents = costs.reduce((sum, c) => sum + c.amountCents, 0);

    const result: UsageDashboardData = {
        period,
        startingAt,
        endingAt,
        models,
        costs,
        totalInputTokens,
        totalOutputTokens,
        totalCacheCreationTokens,
        totalCacheReadTokens,
        totalTokens,
        totalCostCents,
        fetchedAt: new Date().toISOString()
    };

    cache.set(cacheKey, {
        data: result,
        expiresAt: Date.now() + CACHE_TTL_MS
    });

    return result;
}

/**
 * Clear the usage data cache (e.g. when admin key changes).
 */
export function clearUsageCache(): void {
    cache.clear();
}

/**
 * Exported for testing: get date range for a period.
 */
export { getDateRange };
