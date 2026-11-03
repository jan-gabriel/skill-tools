#!/usr/bin/env node
/**
 * validate-skills CLI — CI skill validator
 *
 * Walks skills/**\/SKILL.md files and enforces:
 *   1. Schema validity
 *   2. name == folder name
 *   3. Injection/secret/suspicious-shell lint
 *   4. Security scanner across SKILL.md + all companion files (scripts/, references/, assets/)
 *
 * Exits 0 if all skills pass. Exits 1 on any failure.
 */

import { readFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import matter from "gray-matter";
import { validateSkill, validateNameFolderMatch } from "../skill-schema.js";
import { scanSecurityFiles, classifyTier, type SkillFileContent } from "../security-scan.js";

// ─── Security lints ──────────────────────────────────────────────────────────

interface LintRule {
    name: string;
    test: (content: string) => boolean;
}

const LINT_RULES: LintRule[] = [
    {
        name: "injection:ignore-previous-instructions",
        test: (s) => /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i.test(s),
    },
    {
        name: "injection:disregard-instructions",
        test: (s) => /disregard\s+(all\s+)?instructions/i.test(s),
    },
    {
        name: "injection:system-prompt-leak",
        test: (s) => /repeat\s+(your\s+)?system\s+prompt|print\s+(your\s+)?system\s+prompt/i.test(s),
    },
    {
        name: "secret:api-key-literal",
        test: (s) => /(?:api[_-]?key|secret[_-]?key|auth[_-]?token)\s*[=:]\s*["'][A-Za-z0-9_\-]{16,}["']/i.test(s),
    },
    {
        name: "secret:private-key-header",
        test: (s) => /-----BEGIN\s+(RSA|EC|OPENSSH|PRIVATE)\s+PRIVATE KEY-----/.test(s),
    },
    {
        name: "shell:curl-pipe-bash",
        test: (s) => /curl[^\n|]*\|\s*(?:ba)?sh\b/i.test(s),
    },
    {
        name: "shell:wget-pipe-sh",
        test: (s) => /wget[^\n|]*\|\s*(?:ba)?sh\b/i.test(s),
    },
    {
        name: "shell:base64-exec",
        test: (s) => /base64\s+--decode[^\n|]*\|\s*(?:ba)?sh\b/i.test(s),
    },
    {
        name: "shell:suspicious-exfil-url",
        test: (s) =>
            /https?:\/\/[a-z0-9.-]+\.(ngrok\.io|burpcollaborator\.net|requestbin\.|webhook\.site|pipedream\.net)/i.test(s),
    },
];

// ─── Walker ──────────────────────────────────────────────────────────────────

interface SkillError {
    file: string;
    errors: string[];
}

async function validateAll(skillsRoot: string): Promise<SkillError[]> {
    const failures: SkillError[] = [];
    const skillFiles = await collectSkillFiles(skillsRoot);

    for (const absPath of skillFiles) {
        const errors: string[] = [];
        let raw: string;
        try {
            raw = await readFile(absPath, "utf-8");
        } catch (e) {
            failures.push({ file: absPath, errors: [`cannot read file: ${(e as Error).message}`] });
            continue;
        }

        const parsed = matter(raw);
        const fm = parsed.data as Record<string, unknown>;
        const body = parsed.content;

        // 1. Schema validation
        const result = validateSkill(fm, body);
        if (!result.valid) {
            errors.push(...result.errors.map((e) => `schema: ${e}`));
        }

        // 2. name == folder name
        const folderName = basename(dirname(absPath));
        if (typeof fm.name === "string" && !validateNameFolderMatch(fm.name, folderName)) {
            errors.push(`name mismatch: frontmatter name "${fm.name}" != folder "${folderName}"`);
        }

        // 3. Security lint (fast regex rules) — applied only to SKILL.md
        for (const rule of LINT_RULES) {
            if (rule.test(raw)) {
                errors.push(`lint: ${rule.name}`);
            }
        }

        // 4. Security scanner — scan SKILL.md + all companion files in the skill dir
        const skillDir = dirname(absPath);
        const companionFiles = await collectAllFiles(skillDir);
        const filesToScan: SkillFileContent[] = [
            { path: absPath, content: raw },
            ...await Promise.all(
                companionFiles
                    .filter((f) => f !== absPath)
                    .map(async (f) => ({ path: f, content: await readFile(f, "utf-8").catch(() => "") }))
            ),
        ];
        const { score, findings } = scanSecurityFiles(filesToScan);
        const tier = classifyTier(score, findings);
        if (tier === "unsafe") {
            errors.push(`security: tier=unsafe (score=${score})`);
        }

        const fileCount = filesToScan.length;
        if (errors.length === 0) {
            if (tier === "review") {
                console.warn(`  REVIEW  score=${score}  files=${fileCount}  ${absPath}  (tier=review)`);
            } else {
                console.log(`  OK      score=${score}  files=${fileCount}  ${absPath}`);
            }
        }

        if (errors.length) {
            failures.push({ file: absPath, errors });
        }
    }

    return failures;
}

async function collectSkillFiles(skillsRoot: string): Promise<string[]> {
    const files: string[] = [];
    await walkSkillMds(skillsRoot, files);
    return files;
}

async function walkSkillMds(dir: string, out: string[]): Promise<void> {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
        const { readdir } = await import("node:fs/promises");
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
            await walkSkillMds(full, out);
        } else if (e.name === "SKILL.md") {
            out.push(full);
        }
    }
}

async function collectAllFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    let entries: { name: string; isDirectory(): boolean }[];
    try {
        const { readdir } = await import("node:fs/promises");
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return results;
    }
    for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
            results.push(...await collectAllFiles(full));
        } else {
            results.push(full);
        }
    }
    return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const skillsRoot = process.argv[2] ?? "skills";

console.log(`Validating skills in: ${skillsRoot}`);
const failures = await validateAll(skillsRoot);

if (failures.length === 0) {
    console.log("All skills valid.");
    process.exit(0);
} else {
    for (const f of failures) {
        console.error(`\nFAIL: ${f.file}`);
        for (const e of f.errors) {
            console.error(`  ✗ ${e}`);
        }
    }
    console.error(`\n${failures.length} skill(s) failed validation.`);
    process.exit(1);
}
