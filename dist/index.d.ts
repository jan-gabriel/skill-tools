import { z } from 'zod';

declare const SkillRequiresSchema: z.ZodObject<{
    mcp_servers: z.ZodDefault<z.ZodArray<z.ZodString>>;
    tools: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
declare const SkillSourceSchema: z.ZodEnum<{
    official: "official";
    curated: "curated";
    community: "community";
}>;
declare const SkillFrontmatterSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodString;
    domain: z.ZodString;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    requires: z.ZodDefault<z.ZodObject<{
        mcp_servers: z.ZodDefault<z.ZodArray<z.ZodString>>;
        tools: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    version: z.ZodDefault<z.ZodString>;
    source: z.ZodDefault<z.ZodEnum<{
        official: "official";
        curated: "curated";
        community: "community";
    }>>;
    review_status: z.ZodOptional<z.ZodEnum<{
        pending: "pending";
        approved: "approved";
    }>>;
}, z.core.$strip>;
type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
type SkillRequires = z.infer<typeof SkillRequiresSchema>;
type ValidationResult = {
    valid: true;
    data: SkillFrontmatter;
} | {
    valid: false;
    errors: string[];
};
declare function validateSkill(frontmatter: unknown, body: string): ValidationResult;
declare function validateNameFolderMatch(name: string, folderName: string): boolean;

/**
 * Security scanner for skill content.
 *
 * Scans SKILL.md (full raw content including frontmatter) against a set of
 * threat-category patterns and computes a 0–100 security score:
 *   score = max(0, 100 − (CRIT×20 + HIGH×10 + MED×3 + LOW×1))
 *   5+ CRIT findings → score = 0
 *
 * Threat categories (11): command-injection, data-exfiltration,
 * credential-harvesting, prompt-injection, obfuscation, sensitive-file-access,
 * external-calls, destructive-command, reverse-shell, social-engineering,
 * supply-chain.
 */
type Severity = "CRIT" | "HIGH" | "MED" | "LOW";
type SecurityTier = "safe" | "review" | "unsafe";
/** Classify score + CRIT count into a tier.
 *  safe:   score >= 80 AND zero CRIT findings
 *  review: score 50–79 OR exactly 1 CRIT finding
 *  unsafe: score < 50 OR >= 2 CRIT findings
 */
declare function classifyTier(score: number, findings: SecurityFinding[]): SecurityTier;
interface SecurityFinding {
    category: string;
    severity: Severity;
    line: number;
    match: string;
    file?: string;
}
interface SkillFileContent {
    path: string;
    content: string;
}
interface SecurityScanResult {
    score: number;
    findings: SecurityFinding[];
}
/**
 * Scan the full raw content of a skill file (including frontmatter) for security
 * threats. Returns a score and per-finding detail list.
 */
declare function scanSecurity(content: string): SecurityScanResult;
/**
 * Scan all files in a skill directory (SKILL.md + scripts/ + references/ + assets/).
 * Each finding is tagged with the relative path of the source file.
 * Score is computed over the aggregate finding set — a CRIT in any file drags the
 * overall score and tier down (weakest-link across the whole skill).
 */
declare function scanSecurityFiles(files: SkillFileContent[]): SecurityScanResult;

interface IngestedSkill {
    frontmatter: SkillFrontmatter;
    body: string;
    outputDir: string;
    outputPath: string;
    sourceFile: string;
    warnings: string[];
}

declare function deriveDescription(fm: Record<string, unknown>, body: string): Promise<string>;
declare function deriveDomain(fm: Record<string, unknown>, body: string): string;
declare function deriveTags(fm: Record<string, unknown>, body: string, name?: string): string[];
declare function deriveRequires(body: string): {
    mcp_servers: string[];
    tools: string[];
};
type SkillSource = "official" | "curated" | "community";
interface IngestOptions {
    skillsRoot: string;
    dryRun?: boolean;
    source?: SkillSource;
}
/** Ingest one raw skill file → derive metadata → write skills/<domain>/<name>/SKILL.md */
declare function ingestFile(filePath: string, opts: IngestOptions): Promise<IngestedSkill>;
/** Ingest a skill directory (SKILL.md + optional scripts/references) without losing companions. */
declare function ingestSkillDirectory(skillDir: string, opts: IngestOptions): Promise<IngestedSkill>;
/**
 * Run ingest on every skill under a provenance-organized directory.
 * Accepts either flat *.skill.md / *.md files or skill folders containing SKILL.md
 * with companion scripts/references. The first path segment below sourceDir may
 * be official|curated|community; otherwise `opts.source` (default: curated) is used.
 */
declare function ingestDirectory(sourceDir: string, opts: IngestOptions): Promise<IngestedSkill[]>;
/** Compute SHA-256 hex digest of a string */
declare function sha256(content: string): string;
/** Check whether a SKILL.md at the given path already exists */
declare function skillExists(outputPath: string): boolean;

/** BM25-inspired sparse embedding — deterministic, no model download.
 *  Extracted from auto-discover-mcp embed.ts; kept pure for skill-tools.
 */
declare const EMBEDDING_DIMS = 384;
declare function generateBM25Embedding(text: string): Float32Array;

export { EMBEDDING_DIMS, type IngestOptions, type IngestedSkill, type SecurityFinding, type SecurityScanResult, type SecurityTier, type Severity, type SkillFileContent, type SkillFrontmatter, SkillFrontmatterSchema, type SkillRequires, SkillRequiresSchema, type SkillSource, SkillSourceSchema, type ValidationResult, classifyTier, deriveDescription, deriveDomain, deriveRequires, deriveTags, generateBM25Embedding, ingestDirectory, ingestFile, ingestSkillDirectory, scanSecurity, scanSecurityFiles, sha256, skillExists, validateNameFolderMatch, validateSkill };
