import { describe, it, expect } from "vitest";
import { dashboardHtml } from "../src/dashboard.js";

describe("dashboardHtml", () => {
    it("returns a valid HTML string", () => {
        const html = dashboardHtml(true);
        expect(html).toContain("<!DOCTYPE html>");
        expect(html).toContain("</html>");
    });

    it("includes sign-out link when hasPassword is true", () => {
        const html = dashboardHtml(true);
        expect(html).toContain('href="/dashboard/logout"');
        expect(html).toContain("Sign out");
    });

    it("omits sign-out link when hasPassword is false", () => {
        const html = dashboardHtml(false);
        expect(html).not.toContain('href="/dashboard/logout"');
    });

    describe("inline JavaScript syntax validity", () => {
        it("does not contain unescaped apostrophes in single-quoted JS strings", () => {
            const html = dashboardHtml(true);

            // Extract all <script> blocks from the HTML
            const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
            let match;
            const scripts: string[] = [];
            while ((match = scriptRegex.exec(html)) !== null) {
                scripts.push(match[1]);
            }

            expect(scripts.length).toBeGreaterThan(0);

            // The "project's" text must appear with an escaped apostrophe
            // in the rendered JS output (i.e., project\'s inside single quotes)
            const fullText = scripts.join("\n");
            expect(fullText).toContain("project\\'s");
        });

        it("properly escapes the subscription error message apostrophe", () => {
            const html = dashboardHtml(true);

            // The rendered HTML/JS should contain project\'s (escaped for JS single-quoted string)
            // NOT project's (which would break the JS string)
            expect(html).toContain("project\\'s");
            expect(html).not.toMatch(
                /Configure <code>claudeOauthRefreshToken<\/code> in a project's/
            );
        });
    });
});
