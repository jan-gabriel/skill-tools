#!/usr/bin/env node
import {
  validateNameFolderMatch,
  validateSkill
} from "./chunk-3CIKDMUS.js";
import {
  classifyTier,
  scanSecurityFiles
} from "./chunk-I3DVXCCU.js";

// src/cli/validate.ts
import { readFile } from "fs/promises";
import { join, dirname, basename } from "path";
import matter from "gray-matter";
var LINT_RULES = [
  {
    name: "injection:ignore-previous-instructions",
    test: (s) => /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i.test(s)
  },
  {
    name: "injection:disregard-instructions",
    test: (s) => /disregard\s+(all\s+)?instructions/i.test(s)
  },
  {
    name: "injection:system-prompt-leak",
    test: (s) => /repeat\s+(your\s+)?system\s+prompt|print\s+(your\s+)?system\s+prompt/i.test(s)
  },
  {
    name: "secret:api-key-literal",
    test: (s) => /(?:api[_-]?key|secret[_-]?key|auth[_-]?token)\s*[=:]\s*["'][A-Za-z0-9_\-]{16,}["']/i.test(s)
  },
  {
    name: "secret:private-key-header",
    test: (s) => /-----BEGIN\s+(RSA|EC|OPENSSH|PRIVATE)\s+PRIVATE KEY-----/.test(s)
  },
  {
    name: "shell:curl-pipe-bash",
    test: (s) => /curl[^\n|]*\|\s*(?:ba)?sh\b/i.test(s)
  },
  {
    name: "shell:wget-pipe-sh",
    test: (s) => /wget[^\n|]*\|\s*(?:ba)?sh\b/i.test(s)
  },
  {
    name: "shell:base64-exec",
    test: (s) => /base64\s+--decode[^\n|]*\|\s*(?:ba)?sh\b/i.test(s)
  },
  {
    name: "shell:suspicious-exfil-url",
    test: (s) => /https?:\/\/[a-z0-9.-]+\.(ngrok\.io|burpcollaborator\.net|requestbin\.|webhook\.site|pipedream\.net)/i.test(s)
  }
];
async function validateAll(skillsRoot2) {
  const failures2 = [];
  const skillFiles = await collectSkillFiles(skillsRoot2);
  for (const absPath of skillFiles) {
    const errors = [];
    let raw;
    try {
      raw = await readFile(absPath, "utf-8");
    } catch (e) {
      failures2.push({ file: absPath, errors: [`cannot read file: ${e.message}`] });
      continue;
    }
    const parsed = matter(raw);
    const fm = parsed.data;
    const body = parsed.content;
    const result = validateSkill(fm, body);
    if (!result.valid) {
      errors.push(...result.errors.map((e) => `schema: ${e}`));
    }
    const folderName = basename(dirname(absPath));
    if (typeof fm.name === "string" && !validateNameFolderMatch(fm.name, folderName)) {
      errors.push(`name mismatch: frontmatter name "${fm.name}" != folder "${folderName}"`);
    }
    for (const rule of LINT_RULES) {
      if (rule.test(raw)) {
        errors.push(`lint: ${rule.name}`);
      }
    }
    const skillDir = dirname(absPath);
    const companionFiles = await collectAllFiles(skillDir);
    const filesToScan = [
      { path: absPath, content: raw },
      ...await Promise.all(
        companionFiles.filter((f) => f !== absPath).map(async (f) => ({ path: f, content: await readFile(f, "utf-8").catch(() => "") }))
      )
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
      failures2.push({ file: absPath, errors });
    }
  }
  return failures2;
}
async function collectSkillFiles(skillsRoot2) {
  const files = [];
  await walkSkillMds(skillsRoot2, files);
  return files;
}
async function walkSkillMds(dir, out) {
  let entries;
  try {
    const { readdir } = await import("fs/promises");
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
async function collectAllFiles(dir) {
  const results = [];
  let entries;
  try {
    const { readdir } = await import("fs/promises");
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
var skillsRoot = process.argv[2] ?? "skills";
console.log(`Validating skills in: ${skillsRoot}`);
var failures = await validateAll(skillsRoot);
if (failures.length === 0) {
  console.log("All skills valid.");
  process.exit(0);
} else {
  for (const f of failures) {
    console.error(`
FAIL: ${f.file}`);
    for (const e of f.errors) {
      console.error(`  \u2717 ${e}`);
    }
  }
  console.error(`
${failures.length} skill(s) failed validation.`);
  process.exit(1);
}
