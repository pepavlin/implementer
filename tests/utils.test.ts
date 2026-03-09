import { describe, it, expect } from "vitest";
import { buildChainHistory, buildPrDescription, buildPrBody, type ChainTaskInfo } from "../src/task-manager/utils.js";

describe("buildPrDescription", () => {
    it("wraps the task prompt under a ## Task heading", () => {
        const result = buildPrDescription("Add dark mode toggle");
        expect(result).toBe("## Task\n\nAdd dark mode toggle");
    });

    it("preserves multi-line prompts verbatim", () => {
        const prompt = "Fix login bug\n\nUsers cannot log in with email.";
        const result = buildPrDescription(prompt);
        expect(result).toBe(`## Task\n\n${prompt}`);
    });
});

describe("buildPrBody", () => {
    it("returns summary and commits when both are provided", () => {
        const logs = new Map([["repo", "abc123 feat: add stuff"]]);
        const result = buildPrBody("Implemented the feature.", logs);
        expect(result).toContain("## Summary\n\nImplemented the feature.");
        expect(result).toContain("## Commits\n\nabc123 feat: add stuff");
    });

    it("returns only summary when commit logs are empty", () => {
        const result = buildPrBody("Done.", new Map());
        expect(result).toBe("## Summary\n\nDone.");
    });

    it("returns only commits when assistant message is empty", () => {
        const logs = new Map([["repo", "abc123 fix: bug"]]);
        const result = buildPrBody("", logs);
        expect(result).toBe("## Commits\n\nabc123 fix: bug");
    });

    it("returns fallback when both are empty", () => {
        const result = buildPrBody("", new Map());
        expect(result).toBe("No summary available.");
    });

    it("joins commits from multiple repos with newlines", () => {
        const logs = new Map([
            ["repo-a", "aaa feat: first"],
            ["repo-b", "bbb fix: second"],
        ]);
        const result = buildPrBody("Summary", logs);
        expect(result).toContain("aaa feat: first\nbbb fix: second");
    });
});

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
