import { describe, it, expect } from "vitest";
import { validateSkill, validateNameFolderMatch, SkillFrontmatterSchema } from "../src/skill-schema.js";

const VALID_FM = {
    name: "web-researcher-pro",
    description: "Performs deep web research with source credibility assessment.",
    domain: "research",
    tags: ["web-search", "research", "citations"],
    requires: { mcp_servers: [], tools: ["web_search"] },
    version: "0.1.0",
};

const VALID_BODY = "A".repeat(60);

describe("validateSkill", () => {
    it("accepts valid frontmatter and body", () => {
        const r = validateSkill(VALID_FM, VALID_BODY);
        expect(r.valid).toBe(true);
    });

    it("rejects body shorter than 50 chars", () => {
        const r = validateSkill(VALID_FM, "short");
        expect(r.valid).toBe(false);
        expect((r as { valid: false; errors: string[] }).errors[0]).toMatch(/50/);
    });

    it("accepts empty description (pending human review sentinel)", () => {
        const r = validateSkill({ ...VALID_FM, description: "" }, VALID_BODY);
        expect(r.valid).toBe(true);
    });

    it("rejects non-kebab name", () => {
        const r = validateSkill({ ...VALID_FM, name: "Web Researcher" }, VALID_BODY);
        expect(r.valid).toBe(false);
        expect((r as { valid: false; errors: string[] }).errors.join(" ")).toMatch(/kebab/);
    });

    it("rejects description > 200 chars", () => {
        const r = validateSkill({ ...VALID_FM, description: "X".repeat(201) }, VALID_BODY);
        expect(r.valid).toBe(false);
        expect((r as { valid: false; errors: string[] }).errors.join(" ")).toMatch(/200/);
    });

    it("rejects invalid semver", () => {
        const r = validateSkill({ ...VALID_FM, version: "1.0" }, VALID_BODY);
        expect(r.valid).toBe(false);
        expect((r as { valid: false; errors: string[] }).errors.join(" ")).toMatch(/semver/i);
    });

    it("rejects invalid review_status", () => {
        const r = validateSkill({ ...VALID_FM, review_status: "unknown" }, VALID_BODY);
        expect(r.valid).toBe(false);
    });

    it("accepts pending review_status", () => {
        const r = validateSkill({ ...VALID_FM, review_status: "pending" }, VALID_BODY);
        expect(r.valid).toBe(true);
    });

    it("defaults tags and requires when omitted", () => {
        const fm = { name: "foo-bar", description: "A".repeat(20), domain: "test", version: "0.1.0" };
        const r = validateSkill(fm, VALID_BODY);
        expect(r.valid).toBe(true);
        if (r.valid) {
            expect(r.data.tags).toEqual([]);
            expect(r.data.requires.mcp_servers).toEqual([]);
        }
    });
});

describe("validateNameFolderMatch", () => {
    it("returns true when names match exactly", () => {
        expect(validateNameFolderMatch("web-researcher-pro", "web-researcher-pro")).toBe(true);
    });

    it("returns false when names differ", () => {
        expect(validateNameFolderMatch("web-researcher-pro", "web-researcher")).toBe(false);
    });
});

describe("SkillFrontmatterSchema direct", () => {
    it("coerces requires default when requires is omitted", () => {
        const r = SkillFrontmatterSchema.safeParse({
            name: "my-skill",
            description: "A".repeat(20),
            domain: "dev",
        });
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.requires).toEqual({ mcp_servers: [], tools: [] });
            expect(r.data.version).toBe("0.1.0");
        }
    });
});
