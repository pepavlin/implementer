import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsageData, clearUsageCache, getDateRange } from "../src/usage-api.js";

describe("usage-api", () => {
    beforeEach(() => {
        clearUsageCache();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        clearUsageCache();
        vi.restoreAllMocks();
    });

    describe("getDateRange", () => {
        it("returns a 7-day range for '7d'", () => {
            const now = Date.now();
            const { startingAt, endingAt } = getDateRange("7d");
            const start = new Date(startingAt).getTime();
            const end = new Date(endingAt).getTime();
            // End should be within a few seconds of now
            expect(Math.abs(end - now)).toBeLessThan(5000);
            // Start should be ~7 days before end
            const diffDays = (end - start) / (1000 * 60 * 60 * 24);
            expect(diffDays).toBeGreaterThan(6.9);
            expect(diffDays).toBeLessThan(7.1);
        });

        it("returns a 30-day range for '30d'", () => {
            const { startingAt, endingAt } = getDateRange("30d");
            const start = new Date(startingAt).getTime();
            const end = new Date(endingAt).getTime();
            const diffDays = (end - start) / (1000 * 60 * 60 * 24);
            expect(diffDays).toBeGreaterThan(29.9);
            expect(diffDays).toBeLessThan(30.1);
        });

        it("returns a 24-hour range for '24h'", () => {
            const { startingAt, endingAt } = getDateRange("24h");
            const start = new Date(startingAt).getTime();
            const end = new Date(endingAt).getTime();
            const diffHours = (end - start) / (1000 * 60 * 60);
            expect(diffHours).toBeGreaterThan(23.9);
            expect(diffHours).toBeLessThan(24.1);
        });

        it("defaults to 7d for unknown period", () => {
            const { startingAt, endingAt } = getDateRange("unknown");
            const start = new Date(startingAt).getTime();
            const end = new Date(endingAt).getTime();
            const diffDays = (end - start) / (1000 * 60 * 60 * 24);
            expect(diffDays).toBeGreaterThan(6.9);
            expect(diffDays).toBeLessThan(7.1);
        });
    });

    describe("fetchUsageData", () => {
        it("aggregates usage data by model", async () => {
            const mockUsageResponse = {
                data: [
                    {
                        snapshot_at: "2025-01-01T00:00:00Z",
                        input_tokens: 1000,
                        output_tokens: 500,
                        cache_creation_input_tokens: 200,
                        cache_read_input_tokens: 100,
                        model: "claude-sonnet-4-5-20250514"
                    },
                    {
                        snapshot_at: "2025-01-02T00:00:00Z",
                        input_tokens: 2000,
                        output_tokens: 1000,
                        cache_creation_input_tokens: 300,
                        cache_read_input_tokens: 150,
                        model: "claude-sonnet-4-5-20250514"
                    },
                    {
                        snapshot_at: "2025-01-01T00:00:00Z",
                        input_tokens: 500,
                        output_tokens: 250,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                        model: "claude-haiku-3-5-20241022"
                    }
                ],
                has_more: false
            };

            const mockCostResponse = {
                data: [
                    {
                        snapshot_at: "2025-01-01T00:00:00Z",
                        amount_cents: "150.50",
                        description: "API Token Usage - claude-sonnet-4-5"
                    },
                    {
                        snapshot_at: "2025-01-01T00:00:00Z",
                        amount_cents: "25.00",
                        description: "API Token Usage - claude-haiku-3-5"
                    }
                ],
                has_more: false
            };

            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockImplementation(async (url) => {
                const urlStr = typeof url === "string" ? url : url.toString();
                if (urlStr.includes("usage_report")) {
                    return new Response(JSON.stringify(mockUsageResponse), {
                        status: 200,
                        headers: { "Content-Type": "application/json" }
                    });
                }
                if (urlStr.includes("cost_report")) {
                    return new Response(JSON.stringify(mockCostResponse), {
                        status: 200,
                        headers: { "Content-Type": "application/json" }
                    });
                }
                return new Response("Not Found", { status: 404 });
            });

            const result = await fetchUsageData("sk-ant-admin-test-key", "7d");

            expect(result.period).toBe("7d");
            expect(result.models).toHaveLength(2);

            // Sonnet should be first (more tokens)
            const sonnet = result.models.find((m) =>
                m.model.includes("sonnet")
            );
            expect(sonnet).toBeDefined();
            expect(sonnet!.inputTokens).toBe(3000);
            expect(sonnet!.outputTokens).toBe(1500);
            expect(sonnet!.cacheCreationTokens).toBe(500);
            expect(sonnet!.cacheReadTokens).toBe(250);
            expect(sonnet!.totalTokens).toBe(5250);

            const haiku = result.models.find((m) =>
                m.model.includes("haiku")
            );
            expect(haiku).toBeDefined();
            expect(haiku!.inputTokens).toBe(500);
            expect(haiku!.outputTokens).toBe(250);
            expect(haiku!.totalTokens).toBe(750);

            // Totals
            expect(result.totalInputTokens).toBe(3500);
            expect(result.totalOutputTokens).toBe(1750);
            expect(result.totalTokens).toBe(6000);

            // Costs
            expect(result.costs).toHaveLength(2);
            expect(result.totalCostCents).toBeCloseTo(175.5);

            expect(result.fetchedAt).toBeDefined();
        });

        it("returns cached data on subsequent calls", async () => {
            const mockBody = JSON.stringify({
                data: [],
                has_more: false
            });

            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockImplementation(async () =>
                new Response(mockBody, {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                })
            );

            const first = await fetchUsageData("sk-ant-admin-test", "7d");
            const second = await fetchUsageData("sk-ant-admin-test", "7d");

            // Should be the same reference (cached)
            expect(first.fetchedAt).toBe(second.fetchedAt);
            // fetch called 2 times initially (usage + cost), not 4
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        });

        it("uses different caches for different periods", async () => {
            const mockBody = JSON.stringify({
                data: [],
                has_more: false
            });

            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockImplementation(async () =>
                new Response(mockBody, {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                })
            );

            await fetchUsageData("sk-ant-admin-test", "7d");
            await fetchUsageData("sk-ant-admin-test", "30d");

            // 2 fetches per period (usage + cost) = 4 total
            expect(fetchSpy).toHaveBeenCalledTimes(4);
        });

        it("throws on API error response", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockResolvedValue(
                new Response(
                    JSON.stringify({ error: { message: "Invalid API key" } }),
                    {
                        status: 401,
                        headers: { "Content-Type": "application/json" }
                    }
                )
            );

            await expect(
                fetchUsageData("sk-ant-admin-invalid", "7d")
            ).rejects.toThrow("Anthropic API error 401");
        });

        it("sends correct headers", async () => {
            const mockBody = JSON.stringify({
                data: [],
                has_more: false
            });

            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockImplementation(async () =>
                new Response(mockBody, {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                })
            );

            await fetchUsageData("sk-ant-admin-test-key-123", "7d");

            const firstCall = fetchSpy.mock.calls[0];
            const options = firstCall[1] as RequestInit;
            const headers = options.headers as Record<string, string>;
            expect(headers["x-api-key"]).toBe("sk-ant-admin-test-key-123");
            expect(headers["anthropic-version"]).toBe("2023-06-01");
        });

        it("handles empty usage data gracefully", async () => {
            const mockBody = JSON.stringify({
                data: [],
                has_more: false
            });

            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockImplementation(async () =>
                new Response(mockBody, {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                })
            );

            const result = await fetchUsageData("sk-ant-admin-test", "7d");

            expect(result.models).toHaveLength(0);
            expect(result.costs).toHaveLength(0);
            expect(result.totalTokens).toBe(0);
            expect(result.totalCostCents).toBe(0);
        });

        it("handles paginated responses", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch");
            let callCount = 0;
            fetchSpy.mockImplementation(async (url) => {
                const urlStr = typeof url === "string" ? url : url.toString();
                callCount++;
                if (urlStr.includes("usage_report")) {
                    if (!urlStr.includes("page=")) {
                        return new Response(
                            JSON.stringify({
                                data: [
                                    {
                                        snapshot_at: "2025-01-01T00:00:00Z",
                                        input_tokens: 100,
                                        output_tokens: 50,
                                        cache_creation_input_tokens: 0,
                                        cache_read_input_tokens: 0,
                                        model: "claude-sonnet-4-5-20250514"
                                    }
                                ],
                                has_more: true,
                                next_page: "page_2"
                            }),
                            {
                                status: 200,
                                headers: {
                                    "Content-Type": "application/json"
                                }
                            }
                        );
                    } else {
                        return new Response(
                            JSON.stringify({
                                data: [
                                    {
                                        snapshot_at: "2025-01-02T00:00:00Z",
                                        input_tokens: 200,
                                        output_tokens: 100,
                                        cache_creation_input_tokens: 0,
                                        cache_read_input_tokens: 0,
                                        model: "claude-sonnet-4-5-20250514"
                                    }
                                ],
                                has_more: false
                            }),
                            {
                                status: 200,
                                headers: {
                                    "Content-Type": "application/json"
                                }
                            }
                        );
                    }
                }
                // Cost report - no pagination
                return new Response(
                    JSON.stringify({ data: [], has_more: false }),
                    {
                        status: 200,
                        headers: { "Content-Type": "application/json" }
                    }
                );
            });

            const result = await fetchUsageData("sk-ant-admin-test", "7d");

            // Should aggregate both pages
            const sonnet = result.models.find((m) =>
                m.model.includes("sonnet")
            );
            expect(sonnet).toBeDefined();
            expect(sonnet!.inputTokens).toBe(300);
            expect(sonnet!.outputTokens).toBe(150);
        });
    });

    describe("clearUsageCache", () => {
        it("forces fresh data on next call", async () => {
            const mockBody = JSON.stringify({
                data: [],
                has_more: false
            });

            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockImplementation(async () =>
                new Response(mockBody, {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                })
            );

            await fetchUsageData("sk-ant-admin-test", "7d");
            expect(fetchSpy).toHaveBeenCalledTimes(2);

            clearUsageCache();

            await fetchUsageData("sk-ant-admin-test", "7d");
            expect(fetchSpy).toHaveBeenCalledTimes(4);
        });
    });
});
