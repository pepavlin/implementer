import { describe, it, expect } from "vitest";
import { buildChainHistory, type ChainTaskInfo } from "../src/task-manager/utils.js";

describe("buildChainHistory", () => {
    it("returns empty string when there are no ancestors", () => {
        expect(buildChainHistory([])).toBe("");
    });

    it("builds context from a single ancestor", () => {
        const ancestors: ChainTaskInfo[] = [
            {
                prompt: "Add login page with email and password",
                status: "completed",
                // Simulate stream-json output with a final assistant message
                output: [
                    JSON.stringify({ message: { content: [{ type: "text", text: "Implemented login page with form validation." }] } }),
                ].join("\n"),
            },
        ];

        const result = buildChainHistory(ancestors);
        expect(result).toContain("Previous tasks in this chain");
        expect(result).toContain('Task 1: "Add login page with email and password"');
        expect(result).toContain("Status: completed");
        expect(result).toContain("Summary: Implemented login page with form validation.");
    });

    it("builds context from multiple ancestors in order", () => {
        const ancestors: ChainTaskInfo[] = [
            {
                prompt: "First task",
                status: "completed",
                output: JSON.stringify({ message: { content: [{ type: "text", text: "Did first thing." }] } }),
            },
            {
                prompt: "Second task",
                status: "failed",
                output: JSON.stringify({ message: { content: [{ type: "text", text: "Tried second thing." }] } }),
            },
        ];

        const result = buildChainHistory(ancestors);
        expect(result).toContain('Task 1: "First task"');
        expect(result).toContain("Status: completed");
        expect(result).toContain('Task 2: "Second task"');
        expect(result).toContain("Status: failed");
    });

    it("truncates long prompts to 120 chars (first line only)", () => {
        const longPrompt = "A".repeat(200) + "\nSecond line should be ignored";
        const ancestors: ChainTaskInfo[] = [
            { prompt: longPrompt, status: "completed", output: "" },
        ];

        const result = buildChainHistory(ancestors);
        // Title should be first line truncated to 120
        expect(result).toContain(`"${"A".repeat(120)}"`);
        expect(result).not.toContain("Second line");
    });

    it("truncates long summaries to 500 chars", () => {
        const longSummary = "B".repeat(800);
        const ancestors: ChainTaskInfo[] = [
            {
                prompt: "Task",
                status: "completed",
                output: JSON.stringify({ message: { content: [{ type: "text", text: longSummary }] } }),
            },
        ];

        const result = buildChainHistory(ancestors);
        expect(result).toContain("B".repeat(500));
        expect(result).not.toContain("B".repeat(501));
    });

    it("shows fallback when output has no assistant message", () => {
        const ancestors: ChainTaskInfo[] = [
            { prompt: "Some task", status: "failed", output: "not valid json" },
        ];

        const result = buildChainHistory(ancestors);
        expect(result).toContain("No summary available.");
    });
});
