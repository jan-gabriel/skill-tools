#!/usr/bin/env node
/**
 * scan-scores CLI — walk a skills/ tree, run the multi-file security scanner
 * per skill directory, and write a scores.json file.
 *
 * Usage: skill-tools scan-scores [skills-root] [output-file]
 *   skills-root   directory containing skills/<domain>/<name>/ tree (default: .)
 *   output-file   where to write scores.json (default: scores.json)
 *
 * Output format:
 *   {
 *     "<name>": { "score": 80, "tier": "safe", "findings": [...] }
 *   }
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { scanSecurityFiles, classifyTier, type SkillFileContent, type SecurityFinding, type SecurityTier } from "../security-scan.js";

interface SkillScoreEntry {
    score: number;
    tier: SecurityTier;
    findings: SecurityFinding[];
}

async function findSkillDirs(skillsRoot: string): Promise<string[]> {
    const skillsDir = path.join(skillsRoot, "skills");
    if (!existsSync(skillsDir)) return [];

    const found: string[] = [];
    const domains = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
    for (const domain of domains) {
        if (!domain.isDirectory()) continue;
        const domainDir = path.join(skillsDir, domain.name);
        const names = await readdir(domainDir, { withFileTypes: true }).catch(() => []);
        for (const name of names) {
            if (!name.isDirectory()) continue;
            const dir = path.join(domainDir, name.name);
            if (existsSync(path.join(dir, "SKILL.md"))) {
                found.push(dir);
            }
        }
    }
    return found.sort();
}

async function collectFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (entry.name === ".DS_Store") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...await collectFiles(full));
        } else if (entry.isFile()) {
            results.push(full);
        }
    }
    return results.sort();
}

async function main(): Promise<void> {
    const skillsRoot = path.resolve(process.argv[2] ?? ".");
    const outFile = path.resolve(process.argv[3] ?? "scores.json");

    const dirs = await findSkillDirs(skillsRoot);
    if (dirs.length === 0) {
        console.warn(`No skills found under ${skillsRoot}/skills/`);
    }

    const scores: Record<string, SkillScoreEntry> = {};

    for (const dir of dirs) {
        const name = path.basename(dir);
        const absFiles = await collectFiles(dir);

        const fileContents: SkillFileContent[] = [];
        for (const absPath of absFiles) {
            const relPath = path.relative(skillsRoot, absPath);
            const content = await readFile(absPath, "utf-8").catch(() => "");
            fileContents.push({ path: relPath, content });
        }

        const { score, findings } = scanSecurityFiles(fileContents);
        const tier = classifyTier(score, findings);
        scores[name] = { score, tier, findings };
    }

    await writeFile(outFile, JSON.stringify(scores, null, 2), "utf-8");

    const tiers = { safe: 0, review: 0, unsafe: 0 };
    for (const entry of Object.values(scores)) tiers[entry.tier]++;

    console.log(`Scanned ${dirs.length} skills → ${path.relative(process.cwd(), outFile)}`);
    console.log(`  safe: ${tiers.safe}  review: ${tiers.review}  unsafe: ${tiers.unsafe}`);
}

main().catch((err: unknown) => {
    console.error("scan-scores: unexpected error:", err);
    process.exit(1);
});
