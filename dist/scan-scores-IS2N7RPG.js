#!/usr/bin/env node
import {
  classifyTier,
  scanSecurityFiles
} from "./chunk-I3DVXCCU.js";

// src/cli/scan-scores.ts
import { readFile, readdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
async function findSkillDirs(skillsRoot) {
  const skillsDir = path.join(skillsRoot, "skills");
  if (!existsSync(skillsDir)) return [];
  const found = [];
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
async function collectFiles(dir) {
  const results = [];
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
async function main() {
  const skillsRoot = path.resolve(process.argv[2] ?? ".");
  const outFile = path.resolve(process.argv[3] ?? "scores.json");
  const dirs = await findSkillDirs(skillsRoot);
  if (dirs.length === 0) {
    console.warn(`No skills found under ${skillsRoot}/skills/`);
  }
  const scores = {};
  for (const dir of dirs) {
    const name = path.basename(dir);
    const absFiles = await collectFiles(dir);
    const fileContents = [];
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
  console.log(`Scanned ${dirs.length} skills \u2192 ${path.relative(process.cwd(), outFile)}`);
  console.log(`  safe: ${tiers.safe}  review: ${tiers.review}  unsafe: ${tiers.unsafe}`);
}
main().catch((err) => {
  console.error("scan-scores: unexpected error:", err);
  process.exit(1);
});
