#!/usr/bin/env node
/**
 * Corpus review report for a curated skill tree.
 *
 * Scans skills/<domain>/<name>/SKILL.md + every companion file, computes the
 * multi-file security score/tier, checks metadata/references, and clusters the
 * corpus by BM25 passage-embedding similarity. It only reports — it never edits,
 * deletes, merges, or approves a skill.
 *
 * Note: duplicate detection uses BM25 embeddings (pure, no model download).
 * For higher-fidelity E5 embedding, run via the full auto-discover-mcp server.
 *
 * Usage: review [skills-root] [output.md]
 *        DUP_THRESHOLD=0.95 (cosine similarity threshold)
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
    scanSecurityFiles,
    classifyTier,
    type SkillFileContent,
    type SecurityFinding,
    type SecurityTier,
} from "../security-scan.js";
import { generateBM25Embedding } from "../bm25-embed.js";

interface SkillRow {
    name: string;
    domain: string;
    tags: string[];
    description: string;
    body: string;
    dir: string;
    source: string;
    files: number;
    score: number;
    tier: SecurityTier;
    findings: SecurityFinding[];
    warnings: string[];
    duplicateOf: string | null;
    duplicateSimilarity: number | null;
}

const PLACEHOLDER_RE = /^(?:todo|tbd|placeholder|lorem ipsum|n\/?a|none|description)\b/i;
const MIN_DESCRIPTION = 40;

async function findSkillDirs(root: string): Promise<string[]> {
    const skillsDir = path.join(root, "skills");
    const found: string[] = [];
    const domains = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
    for (const domain of domains) {
        if (!domain.isDirectory()) continue;
        const domainDir = path.join(skillsDir, domain.name);
        const names = await readdir(domainDir, { withFileTypes: true }).catch(() => []);
        for (const name of names) {
            if (!name.isDirectory()) continue;
            const dir = path.join(domainDir, name.name);
            if (existsSync(path.join(dir, "SKILL.md"))) found.push(dir);
        }
    }
    return found.sort();
}

async function collectFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (entry.name === ".DS_Store") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await collectFiles(full));
        else if (entry.isFile()) out.push(full);
    }
    return out.sort();
}

function referencedTargets(raw: string, fm: Record<string, unknown>): string[] {
    const targets = new Set<string>();

    if (Array.isArray(fm.references)) {
        for (const value of fm.references) {
            if (typeof value === "string") targets.add(value);
        }
    }

    for (const match of raw.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        targets.add(match[1]);
    }

    for (const match of raw.matchAll(/`((?:\.\.\/)?(?:references|scripts|assets|templates|examples|agents|checks|prompts)\/[A-Za-z0-9._\-\/]+)`/g)) {
        targets.add(match[1]);
    }

    return [...targets];
}

function checkReferences(skillDir: string, raw: string, fm: Record<string, unknown>): string[] {
    const missing: string[] = [];
    for (const rawTarget of referencedTargets(raw, fm)) {
        let target = rawTarget.trim();
        if (!target) continue;
        if (/^(?:https?:|mailto:|tel:|data:|#)/i.test(target)) continue;
        if (target.startsWith("<") || target.includes("{") || target.includes("}")) continue;
        if (target.startsWith("/")) continue;

        target = target.split("#")[0].split("?")[0];
        if (!target) continue;
        if (!existsSync(path.resolve(skillDir, target))) {
            missing.push(target);
        }
    }
    return [...new Set(missing)];
}

function cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function escapeCell(value: string): string {
    return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

async function main(): Promise<void> {
    const root = path.resolve(process.argv[2] ?? ".");
    const outPath = path.resolve(process.argv[3] ?? "REVIEW-R3b.md");
    const threshold = Number(process.env.DUP_THRESHOLD ?? "0.95");

    const dirs = await findSkillDirs(root);
    const rows: SkillRow[] = [];

    for (const dir of dirs) {
        const skillMdPath = path.join(dir, "SKILL.md");
        const raw = await readFile(skillMdPath, "utf-8");
        const parsed = matter(raw);
        const fm = parsed.data as Record<string, unknown>;
        const body = parsed.content.trim();

        const absFiles = await collectFiles(dir);
        const fileContents: SkillFileContent[] = [];
        for (const absPath of absFiles) {
            const relative = path.relative(root, absPath);
            const content = await readFile(absPath, "utf-8").catch(() => "");
            fileContents.push({ path: relative, content });
        }

        const { score, findings } = scanSecurityFiles(fileContents);
        const tier = classifyTier(score, findings);

        const name = typeof fm.name === "string" ? fm.name : path.basename(dir);
        const domain = typeof fm.domain === "string" ? fm.domain : "uncategorized";
        const tags = Array.isArray(fm.tags) ? fm.tags.filter((t): t is string => typeof t === "string") : [];
        const description = typeof fm.description === "string" ? fm.description.trim() : "";
        const source = typeof fm.source === "string" ? fm.source : "";

        const warnings: string[] = [];
        if (!description) warnings.push("missing description");
        else if (PLACEHOLDER_RE.test(description)) warnings.push("placeholder description");
        else if (description.length < MIN_DESCRIPTION) warnings.push(`description too short (${description.length} chars)`);
        if (description.length >= 198) warnings.push("description at 200-char limit (truncated during ingest)");
        if (body.trim().length < 50) warnings.push(`body too short (${body.trim().length} chars)`);
        if (name !== path.basename(dir)) warnings.push(`name "${name}" != folder "${path.basename(dir)}"`);
        if (!source) warnings.push("missing source");
        if (tier !== "safe") {
            const counts = findings.reduce<Record<string, number>>((acc, f) => {
                acc[f.severity] = (acc[f.severity] ?? 0) + 1;
                return acc;
            }, {});
            const detail = Object.entries(counts).map(([s, n]) => `${s}:${n}`).join(",");
            warnings.push(`security tier=${tier} score=${score}${detail ? ` (${detail})` : ""}`);
        }
        for (const missing of checkReferences(dir, raw, fm)) {
            warnings.push(`missing referenced file: ${missing}`);
        }

        rows.push({
            name, domain, tags, description, body, dir, source,
            files: absFiles.length, score, tier, findings, warnings,
            duplicateOf: null, duplicateSimilarity: null,
        });
    }

    // ── Near-duplicate clustering on BM25 passage embeddings ─────────────────
    const embeddings: Float32Array[] = [];
    for (const row of rows) {
        const text = [
            row.name.replace(/-/g, " "),
            row.domain.replace(/-/g, " "),
            ...row.tags,
            row.description,
            row.body.slice(0, 2500),
        ].filter(Boolean).join(" ");
        embeddings.push(generateBM25Embedding(`passage: ${text}`));
    }
    const embeddingBackend = "BM25 (skill-tools build; E5 available in full server)";

    const parent = rows.map((_, i) => i);
    const find = (i: number): number => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    const union = (a: number, b: number): void => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
    };

    const bestSim: number[][] = rows.map(() => rows.map(() => 0));
    const allPairs: Array<{ a: string; b: string; sim: number }> = [];
    for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            const sim = cosine(embeddings[i], embeddings[j]);
            bestSim[i][j] = bestSim[j][i] = sim;
            allPairs.push({ a: rows[i].name, b: rows[j].name, sim });
            if (sim >= threshold) union(i, j);
        }
    }
    allPairs.sort((a, b) => b.sim - a.sim);

    const clusters = new Map<number, number[]>();
    for (let i = 0; i < rows.length; i++) {
        const key = find(i);
        const members = clusters.get(key) ?? [];
        members.push(i);
        clusters.set(key, members);
    }

    let duplicatePairs = 0;
    for (const members of clusters.values()) {
        if (members.length < 2) continue;
        const ordered = [...members].sort((a, b) => rows[a].name.localeCompare(rows[b].name));
        const representative = rows[ordered[0]].name;
        for (const idx of ordered.slice(1)) {
            let best = 0;
            for (const other of ordered) {
                if (other !== idx) best = Math.max(best, bestSim[idx][other]);
            }
            rows[idx].duplicateOf = representative;
            rows[idx].duplicateSimilarity = best;
            rows[idx].warnings.push(`near-duplicate of ${representative} (cos=${best.toFixed(3)})`);
            duplicatePairs++;
        }
    }

    rows.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));

    const sourceCounts = new Map<string, number>();
    for (const row of rows) sourceCounts.set(row.source, (sourceCounts.get(row.source) ?? 0) + 1);

    const tierCounts = { safe: 0, review: 0, unsafe: 0 };
    for (const row of rows) tierCounts[row.tier]++;
    const warningRows = rows.filter((r) => r.warnings.length > 0).length;
    const totalFiles = rows.reduce((n, r) => n + r.files, 0);
    const clusterCount = [...clusters.values()].filter((m) => m.length > 1).length;

    const lines: string[] = [];
    lines.push("# R3b — Curated corpus review");
    lines.push("");
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");
    lines.push("Corpus root: `skills/`  ");
    lines.push("Security: multi-file scan of `SKILL.md` + every companion file.  ");
    lines.push(`Duplicate detection: ${embeddingBackend}, cosine ≥ ${threshold.toFixed(2)}; reported only (nothing deleted or merged).`);
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push("| Metric | Count |");
    lines.push("| --- | ---: |");
    lines.push(`| Skills | ${rows.length} |`);
    lines.push(`| Files (including companions) | ${totalFiles} |`);
    lines.push(`| Security tier: safe | ${tierCounts.safe} |`);
    lines.push(`| Security tier: review | ${tierCounts.review} |`);
    lines.push(`| Security tier: unsafe | ${tierCounts.unsafe} |`);
    lines.push(`| Skills with warnings | ${warningRows} |`);
    lines.push(`| Duplicate clusters | ${clusterCount} |`);
    lines.push(`| Skills flagged as near-duplicate | ${duplicatePairs} |`);
    for (const [source, count] of [...sourceCounts.entries()].sort()) {
        lines.push(`| Source: ${source} | ${count} |`);
    }
    lines.push("");
    lines.push("All skills remain `review_status: pending`; nothing in this report is an approval.");
    lines.push("");
    lines.push("## Duplicate detection");
    lines.push("");
    lines.push(`Threshold: cosine ≥ ${threshold.toFixed(2)}. ${clusterCount} cluster(s) with ${duplicatePairs} flagged skill(s).`);
    lines.push("");
    lines.push("Closest pairs across the corpus (for human judgment):");
    lines.push("");
    lines.push("| skill A | skill B | cosine | flagged |");
    lines.push("| --- | --- | ---: | --- |");
    for (const pair of allPairs.slice(0, 12)) {
        lines.push(`| ${pair.a} | ${pair.b} | ${pair.sim.toFixed(3)} | ${pair.sim >= threshold ? "yes" : "no"} |`);
    }
    lines.push("");
    lines.push("## Skills");
    lines.push("");
    lines.push("| name | domain | tags | security_score | security_tier | source | #files | duplicate_of | warnings |");
    lines.push("| --- | --- | --- | ---: | --- | --- | ---: | --- | --- |");
    for (const row of rows) {
        lines.push([
            row.name,
            row.domain,
            row.tags.join(", "),
            String(row.score),
            row.tier,
            row.source,
            String(row.files),
            row.duplicateOf ?? "—",
            row.warnings.length > 0 ? row.warnings.join("; ") : "—",
        ].map(escapeCell).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
    lines.push("");

    await writeFile(outPath, lines.join("\n"), "utf-8");
    console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
    console.log(`Skills: ${rows.length}  safe/review/unsafe: ${tierCounts.safe}/${tierCounts.review}/${tierCounts.unsafe}  dupes: ${duplicatePairs}`);
}

main().catch((err: unknown) => {
    console.error("review: unexpected error:", err);
    process.exit(1);
});
