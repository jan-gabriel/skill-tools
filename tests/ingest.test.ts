import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { ingestFile, ingestDirectory } from "../src/ingest.js";

let tmpDir: string;

beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "ingest-test-"));
});

afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

async function writeSkill(filename: string, content: string): Promise<string> {
    const p = path.join(tmpDir, "source", filename);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content, "utf-8");
    return p;
}

const WEB_RESEARCHER_BODY = `
# Web Researcher Pro

You are now enhanced with the Web Researcher Pro skill. Follow these instructions.

## Capabilities
- Deep web research across multiple sources
- Source credibility assessment
- Research report generation with citations

## Instructions

Use web search to find diverse, authoritative sources.
`.trim();

const MOBILE_BODY = `
# React Native Architecture

Production-ready patterns for React Native development with Expo, including navigation,
state management, native modules, and offline-first architecture.

React Native and Flutter apps benefit from careful architecture planning.
`.trim();

describe("ingestFile", () => {
    it("derives name from H1 when no frontmatter", async () => {
        const p = await writeSkill("web-researcher-pro.md", WEB_RESEARCHER_BODY);
        const result = await ingestFile(p, { skillsRoot: tmpDir, dryRun: true });
        expect(result.frontmatter.name).toBe("web-researcher-pro");
    });

    it("detects research domain from content", async () => {
        const p = await writeSkill("web-researcher-pro.md", WEB_RESEARCHER_BODY);
        const result = await ingestFile(p, { skillsRoot: tmpDir, dryRun: true });
        expect(result.frontmatter.domain).toBe("research");
    });

    it("detects web_search tool requirement", async () => {
        const p = await writeSkill("web-researcher-pro.md", WEB_RESEARCHER_BODY);
        const result = await ingestFile(p, { skillsRoot: tmpDir, dryRun: true });
        expect(result.frontmatter.requires.tools).toContain("web_search");
    });

    it("sets review_status: pending", async () => {
        const p = await writeSkill("web-researcher-pro.md", WEB_RESEARCHER_BODY);
        const result = await ingestFile(p, { skillsRoot: tmpDir, dryRun: true });
        expect(result.frontmatter.review_status).toBe("pending");
    });

    it("detects mobile-development domain", async () => {
        const p = await writeSkill("react-native-arch.md", MOBILE_BODY);
        const result = await ingestFile(p, { skillsRoot: tmpDir, dryRun: true });
        expect(result.frontmatter.domain).toBe("mobile-development");
    });

    it("writes SKILL.md to correct path (non-dryRun)", async () => {
        const p = await writeSkill("web-researcher-pro.md", WEB_RESEARCHER_BODY);
        const result = await ingestFile(p, { skillsRoot: tmpDir, dryRun: false });
        const raw = await readFile(result.outputPath, "utf-8");
        const parsed = matter(raw);
        expect(parsed.data.name).toBe("web-researcher-pro");
        expect(parsed.data.review_status).toBe("pending");
    });

    it("uses frontmatter name/description/domain when present", async () => {
        const content = matter.stringify(MOBILE_BODY, {
            name: "custom-skill",
            description: "A custom skill for testing purposes, short.",
            domain: "testing",
        });
        const p = await writeSkill("custom-skill.md", content);
        const result = await ingestFile(p, { skillsRoot: tmpDir, dryRun: true });
        expect(result.frontmatter.name).toBe("custom-skill");
        expect(result.frontmatter.domain).toBe("testing");
    });
});

const OBJECTIVE_BODY = `
# Data Deduplication Tool

## Category
Web Scraping

## Objective

The Data Deduplication Tool identifies and removes duplicate entries from scraped datasets. It ensures data quality by consolidating results.

## Execution Flow

1. Input ingestion.
`.trim();

const PREAMBLE_BODY = `
# My Skill

You are now enhanced with this skill. Follow these instructions to proceed.

## Instructions

Use web search to find authoritative sources.
`.trim();

describe("description derivation", () => {
    it("extracts from ## Objective section, not from ## Category value", async () => {
        const p = await writeSkill("dedup.md", OBJECTIVE_BODY);
        const result = await ingestFile(p, { skillsRoot: tmpDir, dryRun: true });
        expect(result.frontmatter.description).toContain("identifies and removes duplicate");
        expect(result.frontmatter.description).not.toContain("Web Scraping");
    });

    it("strips persona preamble sentences", async () => {
        const p = await writeSkill("preamble.md", PREAMBLE_BODY);
        const result = await ingestFile(p, { skillsRoot: tmpDir, dryRun: true });
        expect(result.frontmatter.description).not.toMatch(/^You are now enhanced/i);
    });

    it("never writes placeholder text for missing description", async () => {
        const noDescBody = "# Skill\n\n## Setup\n\n- item one\n- item two\n\n## Notes\n\n- more items";
        const p = await writeSkill("no-desc.md", noDescBody);
        const result = await ingestFile(p, { skillsRoot: tmpDir, dryRun: true });
        expect(result.frontmatter.description).not.toMatch(/Skill derived from/);
        expect(result.warnings.some((w) => w.includes("description"))).toBe(true);
    });

    it("uses frontmatter description verbatim (word-sliced at 200)", async () => {
        const longDesc = "A".repeat(180) + " " + "B".repeat(50);
        const content = matter.stringify(MOBILE_BODY, { name: "test-skill", description: longDesc, domain: "test" });
        const p = await writeSkill("test-skill.md", content);
        const result = await ingestFile(p, { skillsRoot: tmpDir, dryRun: true });
        const desc = result.frontmatter.description;
        expect(desc.length).toBeLessThanOrEqual(200);
        expect(desc).not.toMatch(/B/);
    });
});

describe("ingestDirectory", () => {
    it("ingests multiple files", async () => {
        await writeSkill("web-researcher-pro.md", WEB_RESEARCHER_BODY);
        await writeSkill("react-native-arch.md", MOBILE_BODY);
        const results = await ingestDirectory(path.join(tmpDir, "source"), {
            skillsRoot: tmpDir,
            dryRun: true,
        });
        expect(results.length).toBe(2);
    });

    it("returns empty array for empty directory", async () => {
        await mkdir(path.join(tmpDir, "empty"), { recursive: true });
        const results = await ingestDirectory(path.join(tmpDir, "empty"), {
            skillsRoot: tmpDir,
            dryRun: true,
        });
        expect(results).toEqual([]);
    });
});
