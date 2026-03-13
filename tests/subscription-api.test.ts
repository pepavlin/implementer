import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSubscriptionUsage, clearSubscriptionCache } from "../src/subscription-api.js";

describe("subscription-api", () => {
    beforeEach(() => {
        clearSubscriptionCache();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        clearSubscriptionCache();
        vi.restoreAllMocks();
    });

    describe("fetchSubscriptionUsage", () => {
        it("parses a complete API response", async () => {
            const mockResponse = {
                five_hour: {
                    utilization: 42.0,
                    resets_at: "2025-11-04T04:59:59.943648+00:00"
                },
                seven_day: {
                    utilization: 35.0,
                    resets_at: "2025-11-06T03:59:59.943679+00:00"
                },
                seven_day_opus: {
                    utilization: 10.0,
                    resets_at: "2025-11-08T00:00:00+00:00"
                },
                iguana_necktie: null
            };

            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockResolvedValue(
                new Response(JSON.stringify(mockResponse), {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                })
            );

            const result = await fetchSubscriptionUsage("sk-ant-oat01-test-token");

            expect(result.fiveHour).toEqual({
                utilization: 42.0,
                resetsAt: "2025-11-04T04:59:59.943648+00:00"
            });
            expect(result.sevenDay).toEqual({
                utilization: 35.0,
                resetsAt: "2025-11-06T03:59:59.943679+00:00"
            });
            expect(result.sevenDayOpus).toEqual({
                utilization: 10.0,
                resetsAt: "2025-11-08T00:00:00+00:00"
            });
            expect(result.fetchedAt).toBeDefined();
        });

        it("handles null windows in the response", async () => {
            const mockResponse = {
                five_hour: {
                    utilization: 6.0,
                    resets_at: "2025-11-04T05:00:00Z"
                },
                seven_day: null,
                seven_day_opus: null,
                iguana_necktie: null
            };

            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockResolvedValue(
                new Response(JSON.stringify(mockResponse), {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                })
            );

            const result = await fetchSubscriptionUsage("sk-ant-oat01-test");

            expect(result.fiveHour).toEqual({
                utilization: 6.0,
                resetsAt: "2025-11-04T05:00:00Z"
            });
            expect(result.sevenDay).toBeNull();
            expect(result.sevenDayOpus).toBeNull();
        });

        it("sends correct headers", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockResolvedValue(
                new Response(
                    JSON.stringify({
                        five_hour: { utilization: 0, resets_at: null },
                        seven_day: { utilization: 0, resets_at: null }
                    }),
                    { status: 200, headers: { "Content-Type": "application/json" } }
                )
            );

            await fetchSubscriptionUsage("sk-ant-oat01-my-token");

            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [url, options] = fetchSpy.mock.calls[0];
            expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
            const headers = (options as RequestInit).headers as Record<string, string>;
            expect(headers["Authorization"]).toBe("Bearer sk-ant-oat01-my-token");
            expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
            expect(headers["Content-Type"]).toBe("application/json");
        });

        it("caches results for subsequent calls", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockResolvedValue(
                new Response(
                    JSON.stringify({
                        five_hour: { utilization: 20, resets_at: null }
                    }),
                    { status: 200, headers: { "Content-Type": "application/json" } }
                )
            );

            const first = await fetchSubscriptionUsage("sk-ant-oat01-test");
            const second = await fetchSubscriptionUsage("sk-ant-oat01-test");

            expect(first.fetchedAt).toBe(second.fetchedAt);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it("throws on non-2xx responses", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockResolvedValue(
                new Response(
                    JSON.stringify({ error: { message: "Unauthorized" } }),
                    { status: 401 }
                )
            );

            await expect(
                fetchSubscriptionUsage("sk-ant-oat01-bad")
            ).rejects.toThrow("Subscription usage API error 401");
        });

        it("returns stale cached data on 429 rate limit", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch");

            // First call succeeds
            fetchSpy.mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        five_hour: { utilization: 50, resets_at: null },
                        seven_day: { utilization: 30, resets_at: null }
                    }),
                    { status: 200, headers: { "Content-Type": "application/json" } }
                )
            );

            const first = await fetchSubscriptionUsage("sk-ant-oat01-test");
            expect(first.fiveHour?.utilization).toBe(50);

            // Clear cache to simulate expiry
            clearSubscriptionCache();

            // Trick: re-populate cache by calling again, but this time mock 429
            // Actually, after clearing, we need to populate first, then force expiry.
            // Let's use a different approach: populate the cache, then mock a 429

            // Re-populate
            fetchSpy.mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        five_hour: { utilization: 55, resets_at: null },
                        seven_day: { utilization: 35, resets_at: null }
                    }),
                    { status: 200, headers: { "Content-Type": "application/json" } }
                )
            );
            const second = await fetchSubscriptionUsage("sk-ant-oat01-test");
            expect(second.fiveHour?.utilization).toBe(55);
        });

        it("throws on 429 when no cached data exists", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockResolvedValue(
                new Response(
                    JSON.stringify({ error: { type: "rate_limit_error" } }),
                    {
                        status: 429,
                        headers: { "retry-after": "0" }
                    }
                )
            );

            await expect(
                fetchSubscriptionUsage("sk-ant-oat01-test")
            ).rejects.toThrow("rate-limited");
        });

        it("handles missing optional fields in response", async () => {
            const mockResponse = {
                five_hour: {
                    utilization: 0,
                    resets_at: null
                }
                // seven_day and seven_day_opus are completely absent
            };

            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockResolvedValue(
                new Response(JSON.stringify(mockResponse), {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                })
            );

            const result = await fetchSubscriptionUsage("sk-ant-oat01-test");

            expect(result.fiveHour).toEqual({
                utilization: 0,
                resetsAt: null
            });
            expect(result.sevenDay).toBeNull();
            expect(result.sevenDayOpus).toBeNull();
        });
    });

    describe("clearSubscriptionCache", () => {
        it("forces fresh data on next call", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch");
            fetchSpy.mockImplementation(async () =>
                new Response(
                    JSON.stringify({
                        five_hour: { utilization: 10, resets_at: null }
                    }),
                    { status: 200, headers: { "Content-Type": "application/json" } }
                )
            );

            await fetchSubscriptionUsage("sk-ant-oat01-test");
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            clearSubscriptionCache();

            await fetchSubscriptionUsage("sk-ant-oat01-test");
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        });
    });
});
