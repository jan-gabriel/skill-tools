import matter from "gray-matter";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { validateSkill } from "./skill-schema.js";
import type { SkillFrontmatter } from "./skill-schema.js";
import type { IngestedSkill } from "./types.js";

// ─── Heuristic derivation helpers ─────────────────────────────────────────

function toKebab(str: string): string {
    return str
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function deriveName(filePath: string, fm: Record<string, unknown>, body: string): string {
    if (typeof fm.name === "string" && fm.name.trim()) {
        return toKebab(fm.name.trim());
    }
    const h1 = body.match(/^#\s+(.+)$/m);
    if (h1) return toKebab(h1[1]);
    const base = path.basename(filePath).replace(/\.skill\.md$|\.md$/, "");
    return toKebab(base);
}

// Slice at a word boundary so descriptions never end mid-word.
function sliceAtWord(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    const at = str.lastIndexOf(" ", maxLen);
    return at > maxLen * 0.7 ? str.slice(0, at).trimEnd() : str.slice(0, maxLen);
}

// Sentence-level patterns that indicate the text is a persona setup, not a description.
const PERSONA_STARTS = [
    /^you are now enhanced/i,
    /^you are a[n]?\s/i,
    /^follow these instructions/i,
    /^with this skill/i,
];

function stripPersonaPreamble(text: string): string {
    // Split on sentence-ending punctuation followed by whitespace
    const sentences = text.split(/(?<=[.!?])\s+/);
    return sentences.filter((s) => !PERSONA_STARTS.some((p) => p.test(s.trim()))).join(" ").trim();
}

// Clean markdown from a prose string for use as a description.
function cleanMarkdown(text: string): string {
    return text
        .replace(/\*\*([^*]+)\*\*/g, "$1")   // bold
        .replace(/\*([^*]+)\*/g, "$1")         // italic
        .replace(/`([^`]+)`/g, "$1")            // inline code
        .replace(/^\*\*[^*]+\*\*[:\s]*/m, "")  // leading bold label like **Objective:**
        .replace(/\s+/g, " ")
        .trim();
}

// Try to extract a description from a specific named section (e.g. ## Objective).
function extractSectionParagraph(body: string, sectionHeading: RegExp): string {
    const match = body.match(new RegExp(`${sectionHeading.source}\\s*\\n+([^#]+)`, "im"));
    if (!match) return "";
    const para = match[1].trim().split(/\n{2,}/)[0]; // first paragraph only
    // Take the first sentence if the paragraph is long
    const firstSentence = para.split(/(?<=[.!?])\s+/)[0];
    return cleanMarkdown(firstSentence ?? para);
}

// Join bullet items from a named section (e.g. ## Capabilities) into a comma-separated string.
function extractBulletSection(body: string, sectionHeading: RegExp): string {
    const match = body.match(new RegExp(`${sectionHeading.source}\\s*\\n+((?:[-*+]\\s+.+\\n?)+)`, "im"));
    if (!match) return "";
    const items = [...match[1].matchAll(/^[-*+]\s+(.+)$/gm)]
        .map((m) => cleanMarkdown(m[1]).trimEnd().replace(/[.;,]+$/, ""))
        .filter((t) => t.length >= 10)
        .slice(0, 4);
    return items.join(", ");
}

// Call Claude (haiku) for description generation if ANTHROPIC_API_KEY is set.
async function llmDescription(body: string): Promise<string | null> {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: "claude-haiku-5-5",
                max_tokens: 100,
                messages: [
                    {
                        role: "user",
                        content:
                            "Write ONE sentence (max 180 chars, no quotes, no preamble) describing what this skill does and when to use it.\n\n" +
                            body.slice(0, 2000),
                    },
                ],
            }),
        });
        if (!resp.ok) return null;
        const data = (await resp.json()) as { content: Array<{ type: string; text: string }> };
        const text = (data.content.find((c) => c.type === "text")?.text ?? "").trim();
        const cleaned = text.replace(/^["']|["']$/g, "").trim();
        return cleaned.length >= 20 ? sliceAtWord(cleaned, 200) : null;
    } catch {
        return null;
    }
}

// Heuristic paragraph extraction: splits by blank lines, skips headings / short paras / bullets.
function heuristicDescription(fm: Record<string, unknown>, body: string): string {
    if (typeof fm.description === "string" && fm.description.trim()) {
        return sliceAtWord(fm.description.trim(), 200);
    }

    // 1. Named sections produce the best descriptions
    for (const heading of [/##\s+Objective/, /##\s+Purpose/, /##\s+Overview/]) {
        const text = extractSectionParagraph(body, heading);
        if (text.length >= 30) return sliceAtWord(text, 200);
    }

    // 2. Bullet list under Capabilities/Features (good fallback for instruction-style skills)
    for (const heading of [/##\s+Capabilities/, /##\s+Features/, /##\s+Use\s+Cases?/]) {
        const text = extractBulletSection(body, heading);
        if (text.length >= 30) return sliceAtWord(text, 200);
    }

    // 3. General paragraph scan: split by double newline, take first usable block
    const paragraphs = body.split(/\n{2,}/);
    for (const raw of paragraphs) {
        const p = raw.trim();
        if (p.startsWith("#")) continue;                    // heading block
        if (p.startsWith("```")) continue;                  // code block
        if (p.match(/^[-*+]\s/m)) continue;                 // list block
        if (p.match(/^\|/m)) continue;                      // table
        if (p.length < 30) continue;                        // too short
        if (p.endsWith(":")) continue;                      // prompt/instruction cue

        const cleaned = cleanMarkdown(p.split("\n")[0]);    // first line of block
        const stripped = stripPersonaPreamble(cleaned);
        if (stripped.length >= 30) return sliceAtWord(stripped, 200);
    }

    return "";
}

export async function deriveDescription(fm: Record<string, unknown>, body: string): Promise<string> {
    // Frontmatter value takes top priority (still word-sliced if > 200)
    if (typeof fm.description === "string" && fm.description.trim()) {
        return sliceAtWord(fm.description.trim(), 200);
    }
    // LLM path (if key available) → heuristic fallback
    const llm = await llmDescription(body);
    if (llm) return llm;
    return heuristicDescription(fm, body);
}

// Domain detection ordered most-specific → least-specific so the first match wins.
const DOMAIN_PATTERNS: Array<{ domain: string; patterns: RegExp[] }> = [
    {
        domain: "3d-graphics",
        patterns: [/three\.?js/i, /\bwebgl\b/i, /\bwebgpu\b/i, /3d.*render/i, /scene.*camera/i],
    },
    {
        domain: "sap-development",
        patterns: [
            /\bSAP\b/,
            /\bABAP\b/i,
            /\bCDS\b/,
            /\bRAP\b/,
            /\bCAP\b/,
            /\bOData\b/i,
            /\bFiori\b/i,
            /\bUI5\b/,
            /\bATC\b/,
            /clean core/i,
            /transport request/i,
            /Cloud Application Programming Model/i,
        ],
    },
    {
        domain: "data-engineering",
        patterns: [/deduplicat/i, /data.quality/i, /fuzzy.match/i, /near.duplicate/i],
    },
    {
        domain: "mobile-development",
        patterns: [/react.native/i, /\bflutter\b/i, /mobile.app/i, /\bexpo\b/i, /ios.*android/i],
    },
    {
        domain: "experimentation",
        patterns: [/A\/B test/i, /\bexperiment design\b/i, /feature flag/i, /experimentation platform/i, /multivariate test/i],
    },
    {
        domain: "product-management",
        patterns: [
            /\bPRD\b/,
            /product requirement/i,
            /requirements? (?:discovery|elicitation)/i,
            /product manager/i,
            /product brainstorming/i,
            /synthesi[sz]e (?:user )?research/i,
            /write (?:a )?(?:feature )?spec/i,
        ],
    },
    {
        domain: "security",
        patterns: [
            /security.review/i,
            /security.focused/i,
            /\bSemgrep\b/,
            /supply.chain risk/i,
            /vulnerabilit/i,
            /threat model/i,
        ],
    },
    {
        domain: "observability",
        patterns: [/\bPromQL\b/, /\bGrafana\b/, /\bLogQL\b/, /\bLoki\b/, /\bPrometheus\b/, /alert rules?/i, /notification polic(?:y|ies)/i, /dashboard JSON/i],
    },
    {
        domain: "devops",
        patterns: [/\bDocker\b/i, /\bKubernetes\b/i, /\bHelm\b/i, /\bKustomize\b/i, /docker.compose/i, /\bCoolify\b/i],
    },
    {
        domain: "reliability",
        patterns: [/\bSRE\b/, /site reliability/i, /error budget/i, /\bSLOs?\b/, /\bSLIs?\b/, /incident (?:response|management)/i],
    },
    {
        domain: "testing",
        patterns: [/property.based test/i, /playwright/i, /test.automation/i, /end.to.end test/i],
    },
    {
        domain: "documentation",
        patterns: [/technical documentation/i, /write clear, maintainable docs/i, /documentation for different audiences/i],
    },
    {
        domain: "frontend",
        patterns: [/frontend design/i, /\bUI design\b/i, /visual design/i, /design system/i],
    },
    {
        domain: "architecture",
        patterns: [/enterprise architecture/i, /architecture framework/i, /solution architecture/i],
    },
    {
        domain: "skill-authoring",
        patterns: [/writing skills/i, /author(?:ing)? (?:agent )?skills/i, /skill quality/i],
    },
    {
        domain: "ai-tooling",
        patterns: [/MCP \(Model Context Protocol\)/i, /MCP server/i, /model context protocol/i, /create new skills/i, /creating a skill/i, /\bskill-creator\b/i],
    },
    {
        domain: "research",
        patterns: [/web.research/i, /source.credib/i, /research.report/i, /web researcher/i],
    },
    {
        domain: "development-workflow",
        patterns: [
            /\bbrainstorm/i,
            /implementation plan/i,
            /executing plans?/i,
            /subagent/i,
            /git worktree/i,
            /code review/i,
            /systematic debugging/i,
            /test-driven development/i,
            /\bTDD\b/,
            /verification before completion/i,
            /development branch/i,
            /delegat(?:e|ion)/i,
            /parallel agents/i,
            /superpowers/i,
        ],
    },
];

const CATEGORY_DOMAIN_MAP: Record<string, string> = {
    "web scraping": "web-scraping",
    "web-scraping": "web-scraping",
    "data": "data-engineering",
    "mobile": "mobile-development",
    "research": "research",
    "3d": "3d-graphics",
    "graphics": "3d-graphics",
    "product": "product-management",
    "security": "security",
    "devops": "devops",
    "sap": "sap-development",
    "testing": "testing",
    "documentation": "documentation",
};

const NAME_DOMAIN_HINTS: Array<{ domain: string; pattern: RegExp }> = [
    { domain: "documentation", pattern: /^(?:documentation|good-readme)$/ },
    { domain: "development-workflow", pattern: /^(?:diagnosing-superpowers|opencode-delegate)$/ },
    { domain: "observability", pattern: /^(?:loki|promql|dashboarding|alerting-irm)$/ },
    { domain: "devops", pattern: /^(?:kubernetes|docker|coolify)/ },
    { domain: "reliability", pattern: /^sre-/ },
    { domain: "experimentation", pattern: /^(?:experiment-|experimentation-|feature-flagging)/ },
    { domain: "product-management", pattern: /^(?:prd-|write-spec|synthesize-research|requirements-discovery|product-brainstorming)/ },
    { domain: "ai-tooling", pattern: /^skill-creator$/ },
    { domain: "skill-authoring", pattern: /^writing-skills$/ },
];

function domainFromName(fm: Record<string, unknown>): string | null {
    if (typeof fm.name !== "string") return null;
    const name = fm.name.trim().toLowerCase();
    for (const { domain, pattern } of NAME_DOMAIN_HINTS) {
        if (pattern.test(name)) return domain;
    }
    return null;
}

export function deriveDomain(fm: Record<string, unknown>, body: string): string {
    // Frontmatter domain field takes highest precedence
    if (typeof fm.domain === "string" && fm.domain.trim()) {
        return fm.domain.trim();
    }

    // A few skill names are unambiguous even when the body mentions adjacent topics.
    const hinted = domainFromName(fm);
    if (hinted) return hinted;

    // Explicit ## Category heading
    const catMatch = body.match(/^##\s+Category\s*\n+(.+)/m);
    if (catMatch) {
        const cat = catMatch[1].trim().toLowerCase();
        const mapped = CATEGORY_DOMAIN_MAP[cat];
        if (mapped) return mapped;
        return toKebab(cat);
    }

    // Content-based scoring
    for (const { domain, patterns } of DOMAIN_PATTERNS) {
        if (patterns.some((p) => p.test(body))) return domain;
    }

    return "uncategorized";
}

const TAG_PATTERNS: Array<{ tag: string; pattern: RegExp }> = [
    // Mobile / 3D / data
    { tag: "react-native", pattern: /react.native/i },
    { tag: "flutter", pattern: /\bflutter\b/i },
    { tag: "ios", pattern: /\bios\b/i },
    { tag: "android", pattern: /\bandroid\b/i },
    { tag: "expo", pattern: /\bexpo\b/i },
    { tag: "cross-platform", pattern: /cross.platform/i },
    { tag: "offline-first", pattern: /offline.first/i },
    { tag: "state-management", pattern: /state.management/i },
    { tag: "navigation", pattern: /\bnavigation\b/i },
    { tag: "threejs", pattern: /three\.?js/i },
    { tag: "webgl", pattern: /\bwebgl\b/i },
    { tag: "webgpu", pattern: /\bwebgpu\b/i },
    { tag: "3d", pattern: /\b3d\b/i },
    { tag: "rendering", pattern: /\brenderer\b/i },
    { tag: "graphics", pattern: /\bgraphics\b/i },
    { tag: "code-generation", pattern: /code.gen/i },
    { tag: "web-search", pattern: /web.search/i },
    { tag: "research", pattern: /\bresearch\b/i },
    { tag: "citations", pattern: /citation/i },
    { tag: "report-generation", pattern: /report.gen/i },
    { tag: "data-quality", pattern: /data.quality/i },
    { tag: "deduplication", pattern: /deduplicat/i },
    { tag: "csv", pattern: /\bcsv\b/i },
    { tag: "json", pattern: /\bjson\b/i },
    { tag: "fuzzy-matching", pattern: /fuzzy.match/i },
    { tag: "web-scraping", pattern: /web.scrap/i },
    // SAP / ABAP
    { tag: "sap", pattern: /\bSAP\b/ },
    { tag: "abap", pattern: /\bABAP\b/i },
    { tag: "cds", pattern: /\bCDS\b/ },
    { tag: "cap", pattern: /\bCAP\b/ },
    { tag: "rap", pattern: /\bRAP\b/ },
    { tag: "odata", pattern: /\bOData\b/i },
    { tag: "fiori", pattern: /\bFiori\b/i },
    { tag: "ui5", pattern: /\bUI5\b/ },
    { tag: "clean-core", pattern: /clean core/i },
    { tag: "transport", pattern: /transport (?:request|gate|management)/i },
    // Security / testing
    { tag: "security", pattern: /\bsecurity\b/i },
    { tag: "code-review", pattern: /code.review/i },
    { tag: "semgrep", pattern: /\bSemgrep\b/ },
    { tag: "vulnerability", pattern: /vulnerabilit/i },
    { tag: "supply-chain", pattern: /supply.chain/i },
    { tag: "testing", pattern: /\btest(?:s|ing)?\b/i },
    { tag: "property-based-testing", pattern: /property.based test/i },
    { tag: "playwright", pattern: /playwright/i },
    // Infra / observability
    { tag: "docker", pattern: /\bDocker\b/i },
    { tag: "docker-compose", pattern: /docker.compose/i },
    { tag: "kubernetes", pattern: /\bKubernetes\b/i },
    { tag: "helm", pattern: /\bHelm\b/i },
    { tag: "kustomize", pattern: /\bKustomize\b/i },
    { tag: "coolify", pattern: /\bCoolify\b/i },
    { tag: "grafana", pattern: /\bGrafana\b/ },
    { tag: "promql", pattern: /\bPromQL\b/ },
    { tag: "loki", pattern: /\bLoki\b/ },
    { tag: "observability", pattern: /\bobservability\b/i },
    { tag: "alerting", pattern: /\balert(?:ing|s)?\b/i },
    { tag: "sre", pattern: /\bSRE\b|site reliability/i },
    { tag: "slo", pattern: /\bSLOs?\b/ },
    { tag: "incident-response", pattern: /incident (?:response|management)/i },
    { tag: "on-call", pattern: /on.call/i },
    // Product / experimentation / docs
    { tag: "prd", pattern: /\bPRD\b/ },
    { tag: "requirements", pattern: /requirements?\b/i },
    { tag: "product-management", pattern: /product manager|product requirement/i },
    { tag: "experimentation", pattern: /experiment(?:ation)?\b/i },
    { tag: "ab-testing", pattern: /A\/B test/i },
    { tag: "feature-flags", pattern: /feature flag/i },
    { tag: "analytics", pattern: /\banalytics\b/i },
    { tag: "documentation", pattern: /\bdocumentation\b/i },
    { tag: "readme", pattern: /\bREADME\b/i },
    // Workflow / meta
    { tag: "brainstorming", pattern: /brainstorm/i },
    { tag: "planning", pattern: /(?:implementation|writing) plan/i },
    { tag: "git", pattern: /\bgit\b/i },
    { tag: "worktree", pattern: /worktree/i },
    { tag: "subagents", pattern: /subagent/i },
    { tag: "debugging", pattern: /\bdebug(?:ging)?\b/i },
    { tag: "verification", pattern: /verification/i },
    { tag: "tdd", pattern: /test.driven development|\bTDD\b/i },
    { tag: "architecture", pattern: /\barchitecture\b/i },
    { tag: "mcp", pattern: /\bMCP\b|model context protocol/i },
    { tag: "skill-authoring", pattern: /writ(?:e|ing) skills?|create new skills/i },
    { tag: "delegation", pattern: /delegat/i },
    { tag: "frontend", pattern: /frontend/i },
    { tag: "design", pattern: /\bdesign\b/i },
];

function uniqueKebab(values: string[], limit = 10): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const tag = toKebab(value);
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        out.push(tag);
        if (out.length >= limit) break;
    }
    return out;
}

const GENERIC_TAGS = new Set([
    "json", "csv", "testing", "documentation", "requirements", "verification",
    "debugging", "design", "navigation", "citations", "report-generation",
    "web-search", "research", "analytics", "git", "mcp", "planning", "brainstorming",
]);

const NAME_STOPWORDS = new Set([
    "skill", "skills", "the", "and", "for", "with", "a", "an", "to", "of", "in",
    "on", "by", "using", "your", "api", "cli", "guide", "tool", "tools",
    "good", "based", "before", "completion", "driven",
]);

export function deriveTags(fm: Record<string, unknown>, body: string, name?: string): string[] {
    if (Array.isArray(fm.tags) && fm.tags.length > 0) {
        return uniqueKebab(
            (fm.tags as unknown[]).filter((t): t is string => typeof t === "string"),
        );
    }

    const nameTags = (name ?? "")
        .split("-")
        .filter((t) => t.length > 2 && !NAME_STOPWORDS.has(t));

    // Description + the opening of the body is the topical signal; later prose often
    // mentions adjacent tools and would add misleading tags.
    const topicalText = [
        typeof fm.description === "string" ? fm.description : "",
        body.slice(0, 2500),
    ].join("\n");
    const bodyTags = TAG_PATTERNS
        .filter(({ pattern }) => pattern.test(topicalText))
        .map(({ tag }) => tag);

    const specific = bodyTags.filter((t) => !GENERIC_TAGS.has(t));
    const generic = bodyTags.filter((t) => GENERIC_TAGS.has(t));
    return uniqueKebab([...nameTags, ...specific, ...generic]);
}

export function deriveRequires(body: string): { mcp_servers: string[]; tools: string[] } {
    const tools: string[] = [];
    if (/use web search|web search to|browse the web|search the web|web researcher/i.test(body)) {
        tools.push("web_search");
    }
    if (/\bcsv\b|\bjson\s+file|read.*file|write.*file|file.*io/i.test(body)) {
        tools.push("file_io");
    }
    return { mcp_servers: [], tools };
}

// ─── Public API ────────────────────────────────────────────────────────────

export type SkillSource = "official" | "curated" | "community";

const SKILL_SOURCES: SkillSource[] = ["official", "curated", "community"];

function isSkillSource(value: string): value is SkillSource {
    return (SKILL_SOURCES as string[]).includes(value);
}

export interface IngestOptions {
    skillsRoot: string;  // where to write skills/ tree (monorepo root)
    dryRun?: boolean;    // parse + derive only, do not write files
    source?: SkillSource; // provenance fallback when the source path has no official|curated|community segment
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function preserveVersion(fm: Record<string, unknown>): string {
    if (typeof fm.version === "string" && SEMVER_RE.test(fm.version.trim())) {
        return fm.version.trim();
    }
    const metadata = fm.metadata;
    if (metadata && typeof metadata === "object") {
        const metaVersion = (metadata as Record<string, unknown>).version;
        if (typeof metaVersion === "string" && SEMVER_RE.test(metaVersion.trim())) {
            return metaVersion.trim();
        }
    }
    return "0.1.0";
}

function preserveRequires(
    fm: Record<string, unknown>,
    body: string,
): { mcp_servers: string[]; tools: string[] } {
    const requires = fm.requires;
    if (requires && typeof requires === "object") {
        const obj = requires as Record<string, unknown>;
        const strings = (value: unknown): string[] =>
            Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
        return {
            mcp_servers: strings(obj.mcp_servers),
            tools: strings(obj.tools),
        };
    }
    return deriveRequires(body);
}

const PLACEHOLDER_DESC_RE = /^(?:todo|tbd|placeholder|lorem ipsum|n\/?a|none|description)\b/i;

interface FrontmatterBuild {
    frontmatter: SkillFrontmatter;
    warnings: string[];
}

async function buildFrontmatter(
    filePath: string,
    fm: Record<string, unknown>,
    body: string,
    source: SkillSource,
    sourceFolder?: string,
): Promise<FrontmatterBuild> {
    const warnings: string[] = [];

    const name = deriveName(filePath, fm, body);
    if (sourceFolder && name !== sourceFolder) {
        warnings.push(`name "${name}" does not match source folder "${sourceFolder}"`);
    }

    const rawDescription = typeof fm.description === "string" ? fm.description.trim() : "";
    const description = await deriveDescription(fm, body);
    if (!description) {
        warnings.push("could not derive description — fill in manually before approving");
    } else if (PLACEHOLDER_DESC_RE.test(description)) {
        warnings.push("description looks like a placeholder — rewrite before approving");
    }
    if (rawDescription.length > 200) {
        warnings.push(`description truncated from ${rawDescription.length} to 200 chars`);
    }

    const domain = toKebab(deriveDomain(fm, body)) || "uncategorized";
    if (domain === "uncategorized") warnings.push("domain is uncategorized — confirm correct domain");

    const tags = deriveTags(fm, body, name);
    const requires = preserveRequires(fm, body);
    const version = preserveVersion(fm);

    const frontmatter: SkillFrontmatter = {
        name,
        description,  // empty string if no description found; validation will flag it
        domain,
        tags,
        requires,
        version,
        source,
        review_status: "pending",
    };

    const validation = validateSkill(frontmatter, body);
    if (!validation.valid) {
        warnings.push(...validation.errors.map((e) => `validation: ${e}`));
    }

    return { frontmatter, warnings };
}

function outputPaths(opts: IngestOptions, frontmatter: SkillFrontmatter): { outputDir: string; outputPath: string } {
    const outputDir = path.join(opts.skillsRoot, "skills", frontmatter.domain, frontmatter.name);
    return { outputDir, outputPath: path.join(outputDir, "SKILL.md") };
}

async function writeSkill(
    body: string,
    frontmatter: SkillFrontmatter,
    outputDir: string,
    outputPath: string,
): Promise<void> {
    await mkdir(outputDir, { recursive: true });
    // Build SKILL.md: gray-matter serializes frontmatter + body cleanly
    const skillContent = matter.stringify(body, frontmatter as unknown as Record<string, unknown>);
    await writeFile(outputPath, skillContent, "utf-8");
}

/** Copy scripts/, references/, assets/ and any other companion file intact. */
async function copyCompanions(sourceDir: string, outputDir: string): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === "SKILL.md" || entry.name === ".DS_Store") continue;
        const src = path.join(sourceDir, entry.name);
        const dest = path.join(outputDir, entry.name);
        if (entry.isDirectory()) {
            await mkdir(dest, { recursive: true });
            await copyCompanions(src, dest);
        } else if (entry.isFile()) {
            await mkdir(path.dirname(dest), { recursive: true });
            await writeFile(dest, await readFile(src));
        }
    }
}

/** Ingest one raw skill file → derive metadata → write skills/<domain>/<name>/SKILL.md */
export async function ingestFile(
    filePath: string,
    opts: IngestOptions,
): Promise<IngestedSkill> {
    const raw = await readFile(filePath, "utf-8");
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    const body = parsed.content.trim();

    const source = opts.source ?? "curated";
    const { frontmatter, warnings } = await buildFrontmatter(filePath, fm, body, source);
    const { outputDir, outputPath } = outputPaths(opts, frontmatter);

    if (!opts.dryRun) {
        await writeSkill(body, frontmatter, outputDir, outputPath);
    }

    return { frontmatter, body, outputDir, outputPath, sourceFile: filePath, warnings };
}

/** Ingest a skill directory (SKILL.md + optional scripts/references) without losing companions. */
export async function ingestSkillDirectory(
    skillDir: string,
    opts: IngestOptions,
): Promise<IngestedSkill> {
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const raw = await readFile(skillMdPath, "utf-8");
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    const body = parsed.content.trim();

    const source = opts.source ?? "curated";
    const { frontmatter, warnings } = await buildFrontmatter(
        skillMdPath,
        fm,
        body,
        source,
        path.basename(skillDir),
    );
    const { outputDir, outputPath } = outputPaths(opts, frontmatter);

    if (!opts.dryRun) {
        await writeSkill(body, frontmatter, outputDir, outputPath);
        await copyCompanions(skillDir, outputDir);
    }

    return { frontmatter, body, outputDir, outputPath, sourceFile: skillMdPath, warnings };
}

function sourceForPath(sourceRoot: string, absPath: string, fallback: SkillSource): SkillSource {
    const rootName = path.basename(path.resolve(sourceRoot));
    if (isSkillSource(rootName)) return rootName;

    const relative = path.relative(path.resolve(sourceRoot), path.resolve(absPath));
    if (relative && !relative.startsWith("..")) {
        const first = relative.split(path.sep)[0];
        if (isSkillSource(first)) return first;
    }
    return fallback;
}

interface DiscoveredSkill {
    kind: "dir" | "file";
    path: string;
    source: SkillSource;
}

async function discoverSkills(
    sourceDir: string,
    sourceRoot: string,
    fallback: SkillSource,
): Promise<DiscoveredSkill[]> {
    const { readdir } = await import("node:fs/promises");
    const found: DiscoveredSkill[] = [];
    const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
        if (entry.name === ".DS_Store" || entry.name === ".git" || entry.name === "node_modules") continue;
        const full = path.join(sourceDir, entry.name);

        if (entry.isDirectory()) {
            if (existsSync(path.join(full, "SKILL.md"))) {
                found.push({ kind: "dir", path: full, source: sourceForPath(sourceRoot, full, fallback) });
            } else {
                found.push(...await discoverSkills(full, sourceRoot, fallback));
            }
        } else if (entry.isFile() && (entry.name.endsWith(".skill.md") || entry.name.endsWith(".md"))) {
            if (/^readme/i.test(entry.name) || /^notice/i.test(entry.name)) continue;
            found.push({ kind: "file", path: full, source: sourceForPath(sourceRoot, full, fallback) });
        }
    }
    return found;
}

/**
 * Run ingest on every skill under a provenance-organized directory.
 * Accepts either flat *.skill.md / *.md files or skill folders containing SKILL.md
 * with companion scripts/references. The first path segment below sourceDir may
 * be official|curated|community; otherwise `opts.source` (default: curated) is used.
 */
export async function ingestDirectory(
    sourceDir: string,
    opts: IngestOptions,
): Promise<IngestedSkill[]> {
    const fallback = opts.source ?? "curated";
    const discovered = (await discoverSkills(sourceDir, sourceDir, fallback))
        .sort((a, b) => a.path.localeCompare(b.path));

    const results: IngestedSkill[] = [];
    for (const entry of discovered) {
        try {
            const result = entry.kind === "dir"
                ? await ingestSkillDirectory(entry.path, { ...opts, source: entry.source })
                : await ingestFile(entry.path, { ...opts, source: entry.source });
            results.push(result);
        } catch (err) {
            console.error(`ERROR ingesting ${entry.path}: ${(err as Error).message}`);
        }
    }
    return results;
}

/** Compute SHA-256 hex digest of a string */
export function sha256(content: string): string {
    return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Check whether a SKILL.md at the given path already exists */
export function skillExists(outputPath: string): boolean {
    return existsSync(outputPath);
}
