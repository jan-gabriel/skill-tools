import {
  validateSkill
} from "./chunk-3CIKDMUS.js";

// src/ingest.ts
import matter from "gray-matter";
import { createHash } from "crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
function toKebab(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function deriveName(filePath, fm, body) {
  if (typeof fm.name === "string" && fm.name.trim()) {
    return toKebab(fm.name.trim());
  }
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return toKebab(h1[1]);
  const base = path.basename(filePath).replace(/\.skill\.md$|\.md$/, "");
  return toKebab(base);
}
function sliceAtWord(str, maxLen) {
  if (str.length <= maxLen) return str;
  const at = str.lastIndexOf(" ", maxLen);
  return at > maxLen * 0.7 ? str.slice(0, at).trimEnd() : str.slice(0, maxLen);
}
var PERSONA_STARTS = [
  /^you are now enhanced/i,
  /^you are a[n]?\s/i,
  /^follow these instructions/i,
  /^with this skill/i
];
function stripPersonaPreamble(text) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.filter((s) => !PERSONA_STARTS.some((p) => p.test(s.trim()))).join(" ").trim();
}
function cleanMarkdown(text) {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/^\*\*[^*]+\*\*[:\s]*/m, "").replace(/\s+/g, " ").trim();
}
function extractSectionParagraph(body, sectionHeading) {
  const match = body.match(new RegExp(`${sectionHeading.source}\\s*\\n+([^#]+)`, "im"));
  if (!match) return "";
  const para = match[1].trim().split(/\n{2,}/)[0];
  const firstSentence = para.split(/(?<=[.!?])\s+/)[0];
  return cleanMarkdown(firstSentence ?? para);
}
function extractBulletSection(body, sectionHeading) {
  const match = body.match(new RegExp(`${sectionHeading.source}\\s*\\n+((?:[-*+]\\s+.+\\n?)+)`, "im"));
  if (!match) return "";
  const items = [...match[1].matchAll(/^[-*+]\s+(.+)$/gm)].map((m) => cleanMarkdown(m[1]).trimEnd().replace(/[.;,]+$/, "")).filter((t) => t.length >= 10).slice(0, 4);
  return items.join(", ");
}
async function llmDescription(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content: "Write ONE sentence (max 180 chars, no quotes, no preamble) describing what this skill does and when to use it.\n\n" + body.slice(0, 2e3)
          }
        ]
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = (data.content.find((c) => c.type === "text")?.text ?? "").trim();
    const cleaned = text.replace(/^["']|["']$/g, "").trim();
    return cleaned.length >= 20 ? sliceAtWord(cleaned, 200) : null;
  } catch {
    return null;
  }
}
function heuristicDescription(fm, body) {
  if (typeof fm.description === "string" && fm.description.trim()) {
    return sliceAtWord(fm.description.trim(), 200);
  }
  for (const heading of [/##\s+Objective/, /##\s+Purpose/, /##\s+Overview/]) {
    const text = extractSectionParagraph(body, heading);
    if (text.length >= 30) return sliceAtWord(text, 200);
  }
  for (const heading of [/##\s+Capabilities/, /##\s+Features/, /##\s+Use\s+Cases?/]) {
    const text = extractBulletSection(body, heading);
    if (text.length >= 30) return sliceAtWord(text, 200);
  }
  const paragraphs = body.split(/\n{2,}/);
  for (const raw of paragraphs) {
    const p = raw.trim();
    if (p.startsWith("#")) continue;
    if (p.startsWith("```")) continue;
    if (p.match(/^[-*+]\s/m)) continue;
    if (p.match(/^\|/m)) continue;
    if (p.length < 30) continue;
    if (p.endsWith(":")) continue;
    const cleaned = cleanMarkdown(p.split("\n")[0]);
    const stripped = stripPersonaPreamble(cleaned);
    if (stripped.length >= 30) return sliceAtWord(stripped, 200);
  }
  return "";
}
async function deriveDescription(fm, body) {
  if (typeof fm.description === "string" && fm.description.trim()) {
    return sliceAtWord(fm.description.trim(), 200);
  }
  const llm = await llmDescription(body);
  if (llm) return llm;
  return heuristicDescription(fm, body);
}
var DOMAIN_PATTERNS = [
  {
    domain: "3d-graphics",
    patterns: [/three\.?js/i, /\bwebgl\b/i, /\bwebgpu\b/i, /3d.*render/i, /scene.*camera/i]
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
      /Cloud Application Programming Model/i
    ]
  },
  {
    domain: "data-engineering",
    patterns: [/deduplicat/i, /data.quality/i, /fuzzy.match/i, /near.duplicate/i]
  },
  {
    domain: "mobile-development",
    patterns: [/react.native/i, /\bflutter\b/i, /mobile.app/i, /\bexpo\b/i, /ios.*android/i]
  },
  {
    domain: "experimentation",
    patterns: [/A\/B test/i, /\bexperiment design\b/i, /feature flag/i, /experimentation platform/i, /multivariate test/i]
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
      /write (?:a )?(?:feature )?spec/i
    ]
  },
  {
    domain: "security",
    patterns: [
      /security.review/i,
      /security.focused/i,
      /\bSemgrep\b/,
      /supply.chain risk/i,
      /vulnerabilit/i,
      /threat model/i
    ]
  },
  {
    domain: "observability",
    patterns: [/\bPromQL\b/, /\bGrafana\b/, /\bLogQL\b/, /\bLoki\b/, /\bPrometheus\b/, /alert rules?/i, /notification polic(?:y|ies)/i, /dashboard JSON/i]
  },
  {
    domain: "devops",
    patterns: [/\bDocker\b/i, /\bKubernetes\b/i, /\bHelm\b/i, /\bKustomize\b/i, /docker.compose/i, /\bCoolify\b/i]
  },
  {
    domain: "reliability",
    patterns: [/\bSRE\b/, /site reliability/i, /error budget/i, /\bSLOs?\b/, /\bSLIs?\b/, /incident (?:response|management)/i]
  },
  {
    domain: "testing",
    patterns: [/property.based test/i, /playwright/i, /test.automation/i, /end.to.end test/i]
  },
  {
    domain: "documentation",
    patterns: [/technical documentation/i, /write clear, maintainable docs/i, /documentation for different audiences/i]
  },
  {
    domain: "frontend",
    patterns: [/frontend design/i, /\bUI design\b/i, /visual design/i, /design system/i]
  },
  {
    domain: "architecture",
    patterns: [/enterprise architecture/i, /architecture framework/i, /solution architecture/i]
  },
  {
    domain: "skill-authoring",
    patterns: [/writing skills/i, /author(?:ing)? (?:agent )?skills/i, /skill quality/i]
  },
  {
    domain: "ai-tooling",
    patterns: [/MCP \(Model Context Protocol\)/i, /MCP server/i, /model context protocol/i, /create new skills/i, /creating a skill/i, /\bskill-creator\b/i]
  },
  {
    domain: "research",
    patterns: [/web.research/i, /source.credib/i, /research.report/i, /web researcher/i]
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
      /superpowers/i
    ]
  }
];
var CATEGORY_DOMAIN_MAP = {
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
  "documentation": "documentation"
};
var NAME_DOMAIN_HINTS = [
  { domain: "documentation", pattern: /^(?:documentation|good-readme)$/ },
  { domain: "development-workflow", pattern: /^(?:diagnosing-superpowers|opencode-delegate)$/ },
  { domain: "observability", pattern: /^(?:loki|promql|dashboarding|alerting-irm)$/ },
  { domain: "devops", pattern: /^(?:kubernetes|docker|coolify)/ },
  { domain: "reliability", pattern: /^sre-/ },
  { domain: "experimentation", pattern: /^(?:experiment-|experimentation-|feature-flagging)/ },
  { domain: "product-management", pattern: /^(?:prd-|write-spec|synthesize-research|requirements-discovery|product-brainstorming)/ },
  { domain: "ai-tooling", pattern: /^skill-creator$/ },
  { domain: "skill-authoring", pattern: /^writing-skills$/ }
];
function domainFromName(fm) {
  if (typeof fm.name !== "string") return null;
  const name = fm.name.trim().toLowerCase();
  for (const { domain, pattern } of NAME_DOMAIN_HINTS) {
    if (pattern.test(name)) return domain;
  }
  return null;
}
function deriveDomain(fm, body) {
  if (typeof fm.domain === "string" && fm.domain.trim()) {
    return fm.domain.trim();
  }
  const hinted = domainFromName(fm);
  if (hinted) return hinted;
  const catMatch = body.match(/^##\s+Category\s*\n+(.+)/m);
  if (catMatch) {
    const cat = catMatch[1].trim().toLowerCase();
    const mapped = CATEGORY_DOMAIN_MAP[cat];
    if (mapped) return mapped;
    return toKebab(cat);
  }
  for (const { domain, patterns } of DOMAIN_PATTERNS) {
    if (patterns.some((p) => p.test(body))) return domain;
  }
  return "uncategorized";
}
var TAG_PATTERNS = [
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
  { tag: "design", pattern: /\bdesign\b/i }
];
function uniqueKebab(values, limit = 10) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const value of values) {
    const tag = toKebab(value);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= limit) break;
  }
  return out;
}
var GENERIC_TAGS = /* @__PURE__ */ new Set([
  "json",
  "csv",
  "testing",
  "documentation",
  "requirements",
  "verification",
  "debugging",
  "design",
  "navigation",
  "citations",
  "report-generation",
  "web-search",
  "research",
  "analytics",
  "git",
  "mcp",
  "planning",
  "brainstorming"
]);
var NAME_STOPWORDS = /* @__PURE__ */ new Set([
  "skill",
  "skills",
  "the",
  "and",
  "for",
  "with",
  "a",
  "an",
  "to",
  "of",
  "in",
  "on",
  "by",
  "using",
  "your",
  "api",
  "cli",
  "guide",
  "tool",
  "tools",
  "good",
  "based",
  "before",
  "completion",
  "driven"
]);
function deriveTags(fm, body, name) {
  if (Array.isArray(fm.tags) && fm.tags.length > 0) {
    return uniqueKebab(
      fm.tags.filter((t) => typeof t === "string")
    );
  }
  const nameTags = (name ?? "").split("-").filter((t) => t.length > 2 && !NAME_STOPWORDS.has(t));
  const topicalText = [
    typeof fm.description === "string" ? fm.description : "",
    body.slice(0, 2500)
  ].join("\n");
  const bodyTags = TAG_PATTERNS.filter(({ pattern }) => pattern.test(topicalText)).map(({ tag }) => tag);
  const specific = bodyTags.filter((t) => !GENERIC_TAGS.has(t));
  const generic = bodyTags.filter((t) => GENERIC_TAGS.has(t));
  return uniqueKebab([...nameTags, ...specific, ...generic]);
}
function deriveRequires(body) {
  const tools = [];
  if (/use web search|web search to|browse the web|search the web|web researcher/i.test(body)) {
    tools.push("web_search");
  }
  if (/\bcsv\b|\bjson\s+file|read.*file|write.*file|file.*io/i.test(body)) {
    tools.push("file_io");
  }
  return { mcp_servers: [], tools };
}
var SKILL_SOURCES = ["official", "curated", "community"];
function isSkillSource(value) {
  return SKILL_SOURCES.includes(value);
}
var SEMVER_RE = /^\d+\.\d+\.\d+$/;
function preserveVersion(fm) {
  if (typeof fm.version === "string" && SEMVER_RE.test(fm.version.trim())) {
    return fm.version.trim();
  }
  const metadata = fm.metadata;
  if (metadata && typeof metadata === "object") {
    const metaVersion = metadata.version;
    if (typeof metaVersion === "string" && SEMVER_RE.test(metaVersion.trim())) {
      return metaVersion.trim();
    }
  }
  return "0.1.0";
}
function preserveRequires(fm, body) {
  const requires = fm.requires;
  if (requires && typeof requires === "object") {
    const obj = requires;
    const strings = (value) => Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
    return {
      mcp_servers: strings(obj.mcp_servers),
      tools: strings(obj.tools)
    };
  }
  return deriveRequires(body);
}
var PLACEHOLDER_DESC_RE = /^(?:todo|tbd|placeholder|lorem ipsum|n\/?a|none|description)\b/i;
async function buildFrontmatter(filePath, fm, body, source, sourceFolder) {
  const warnings = [];
  const name = deriveName(filePath, fm, body);
  if (sourceFolder && name !== sourceFolder) {
    warnings.push(`name "${name}" does not match source folder "${sourceFolder}"`);
  }
  const rawDescription = typeof fm.description === "string" ? fm.description.trim() : "";
  const description = await deriveDescription(fm, body);
  if (!description) {
    warnings.push("could not derive description \u2014 fill in manually before approving");
  } else if (PLACEHOLDER_DESC_RE.test(description)) {
    warnings.push("description looks like a placeholder \u2014 rewrite before approving");
  }
  if (rawDescription.length > 200) {
    warnings.push(`description truncated from ${rawDescription.length} to 200 chars`);
  }
  const domain = toKebab(deriveDomain(fm, body)) || "uncategorized";
  if (domain === "uncategorized") warnings.push("domain is uncategorized \u2014 confirm correct domain");
  const tags = deriveTags(fm, body, name);
  const requires = preserveRequires(fm, body);
  const version = preserveVersion(fm);
  const frontmatter = {
    name,
    description,
    // empty string if no description found; validation will flag it
    domain,
    tags,
    requires,
    version,
    source,
    review_status: "pending"
  };
  const validation = validateSkill(frontmatter, body);
  if (!validation.valid) {
    warnings.push(...validation.errors.map((e) => `validation: ${e}`));
  }
  return { frontmatter, warnings };
}
function outputPaths(opts, frontmatter) {
  const outputDir = path.join(opts.skillsRoot, "skills", frontmatter.domain, frontmatter.name);
  return { outputDir, outputPath: path.join(outputDir, "SKILL.md") };
}
async function writeSkill(body, frontmatter, outputDir, outputPath) {
  await mkdir(outputDir, { recursive: true });
  const skillContent = matter.stringify(body, frontmatter);
  await writeFile(outputPath, skillContent, "utf-8");
}
async function copyCompanions(sourceDir, outputDir) {
  const { readdir } = await import("fs/promises");
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
async function ingestFile(filePath, opts) {
  const raw = await readFile(filePath, "utf-8");
  const parsed = matter(raw);
  const fm = parsed.data;
  const body = parsed.content.trim();
  const source = opts.source ?? "curated";
  const { frontmatter, warnings } = await buildFrontmatter(filePath, fm, body, source);
  const { outputDir, outputPath } = outputPaths(opts, frontmatter);
  if (!opts.dryRun) {
    await writeSkill(body, frontmatter, outputDir, outputPath);
  }
  return { frontmatter, body, outputDir, outputPath, sourceFile: filePath, warnings };
}
async function ingestSkillDirectory(skillDir, opts) {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  const raw = await readFile(skillMdPath, "utf-8");
  const parsed = matter(raw);
  const fm = parsed.data;
  const body = parsed.content.trim();
  const source = opts.source ?? "curated";
  const { frontmatter, warnings } = await buildFrontmatter(
    skillMdPath,
    fm,
    body,
    source,
    path.basename(skillDir)
  );
  const { outputDir, outputPath } = outputPaths(opts, frontmatter);
  if (!opts.dryRun) {
    await writeSkill(body, frontmatter, outputDir, outputPath);
    await copyCompanions(skillDir, outputDir);
  }
  return { frontmatter, body, outputDir, outputPath, sourceFile: skillMdPath, warnings };
}
function sourceForPath(sourceRoot, absPath, fallback) {
  const rootName = path.basename(path.resolve(sourceRoot));
  if (isSkillSource(rootName)) return rootName;
  const relative = path.relative(path.resolve(sourceRoot), path.resolve(absPath));
  if (relative && !relative.startsWith("..")) {
    const first = relative.split(path.sep)[0];
    if (isSkillSource(first)) return first;
  }
  return fallback;
}
async function discoverSkills(sourceDir, sourceRoot, fallback) {
  const { readdir } = await import("fs/promises");
  const found = [];
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
async function ingestDirectory(sourceDir, opts) {
  const fallback = opts.source ?? "curated";
  const discovered = (await discoverSkills(sourceDir, sourceDir, fallback)).sort((a, b) => a.path.localeCompare(b.path));
  const results = [];
  for (const entry of discovered) {
    try {
      const result = entry.kind === "dir" ? await ingestSkillDirectory(entry.path, { ...opts, source: entry.source }) : await ingestFile(entry.path, { ...opts, source: entry.source });
      results.push(result);
    } catch (err) {
      console.error(`ERROR ingesting ${entry.path}: ${err.message}`);
    }
  }
  return results;
}
function sha256(content) {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}
function skillExists(outputPath) {
  return existsSync(outputPath);
}

export {
  deriveDescription,
  deriveDomain,
  deriveTags,
  deriveRequires,
  ingestFile,
  ingestSkillDirectory,
  ingestDirectory,
  sha256,
  skillExists
};
