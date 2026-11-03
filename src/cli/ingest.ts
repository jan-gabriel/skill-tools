#!/usr/bin/env node
import path from "node:path";
import { ingestDirectory } from "../ingest.js";

const [, , sourceDir, skillsRoot] = process.argv;

if (!sourceDir) {
    console.error("Usage: skill-tools ingest <source-dir> [skills-root]");
    console.error("  source-dir   directory with official|curated|community/<skill>/SKILL.md");
    console.error("               (flat *.skill.md / *.md files also accepted)");
    console.error("  skills-root  where to write skills/ tree (default: cwd)");
    process.exit(1);
}

const resolvedSource = path.resolve(sourceDir);
const resolvedRoot = path.resolve(skillsRoot ?? ".");

console.log(`Ingesting from: ${resolvedSource}`);
console.log(`Writing to:    ${resolvedRoot}/skills/`);
console.log();

const results = await ingestDirectory(resolvedSource, { skillsRoot: resolvedRoot });

let warnings = 0;
for (const r of results) {
    const status = r.warnings.length > 0 ? "WARN" : "OK  ";
    console.log(`[${status}] ${r.frontmatter.domain}/${r.frontmatter.name}`);
    console.log(`       src:  ${path.relative(process.cwd(), r.sourceFile)}`);
    console.log(`       dest: ${path.relative(process.cwd(), r.outputPath)}`);
    if (r.warnings.length > 0) {
        for (const w of r.warnings) console.log(`       ⚠    ${w}`);
        warnings += r.warnings.length;
    }
    console.log();
}

console.log(`Done: ${results.length} skills ingested, ${warnings} warnings.`);
console.log("All skills marked review_status: pending — human review required before merge.");
