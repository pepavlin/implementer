import { describe, it, expect } from "vitest";
import { hasClaudeOutput, extractLastAssistantMessage } from "./executor.js";

describe("hasClaudeOutput", () => {
    it("returns true when stream-json output has a type field", () => {
        const output = '{"type":"assistant","message":{"content":[]}}\n';
        expect(hasClaudeOutput(output)).toBe(true);
    });

    it("returns false for non-JSON output", () => {
        expect(hasClaudeOutput("some random docker log\n")).toBe(false);
    });

    it("returns false for JSON without type field", () => {
        expect(hasClaudeOutput('{"foo":"bar"}\n')).toBe(false);
    });

    it("returns false for empty output", () => {
        expect(hasClaudeOutput("")).toBe(false);
    });
});

describe("extractLastAssistantMessage", () => {
    it("extracts text from the last assistant message", () => {
        const output = [
            '{"message":{"content":[{"type":"text","text":"first"}]}}',
            '{"message":{"content":[{"type":"text","text":"second"}]}}',
        ].join("\n");
        expect(extractLastAssistantMessage(output)).toBe("second");
    });

    it("returns empty string for no messages", () => {
        expect(extractLastAssistantMessage("not json\n")).toBe("");
    });

    it("joins multiple text blocks", () => {
        const output = '{"message":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}';
        expect(extractLastAssistantMessage(output)).toBe("a\nb");
    });

    it("ignores non-text content blocks", () => {
        const output = '{"message":{"content":[{"type":"tool_use","id":"x"},{"type":"text","text":"hello"}]}}';
        expect(extractLastAssistantMessage(output)).toBe("hello");
    });
});
