import { z } from "zod";

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export const SkillRequiresSchema = z.object({
    mcp_servers: z.array(z.string()).default([]),
    tools: z.array(z.string()).default([]),
});

export const SkillSourceSchema = z.enum(["official", "curated", "community"]);

export const SkillFrontmatterSchema = z.object({
    name: z.string().min(1).regex(KEBAB_RE, "name must be kebab-case (lowercase letters, digits, hyphens only)"),
    description: z.string().max(200, "description must be ≤ 200 characters"),
    domain: z.string().min(1),
    tags: z.array(z.string()).default([]),
    requires: SkillRequiresSchema.default({ mcp_servers: [], tools: [] }),
    version: z.string().regex(SEMVER_RE, "version must be semver (e.g. 0.1.0)").default("0.1.0"),
    source: SkillSourceSchema.default("curated"),
    review_status: z.enum(["pending", "approved"]).optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
export type SkillRequires = z.infer<typeof SkillRequiresSchema>;

export type ValidationResult =
    | { valid: true; data: SkillFrontmatter }
    | { valid: false; errors: string[] };

const MIN_BODY_CHARS = 50;

export function validateSkill(frontmatter: unknown, body: string): ValidationResult {
    if (typeof body !== "string" || body.trim().length < MIN_BODY_CHARS) {
        return { valid: false, errors: [`body must be at least ${MIN_BODY_CHARS} characters`] };
    }

    const result = SkillFrontmatterSchema.safeParse(frontmatter);
    if (!result.success) {
        return {
            valid: false,
            errors: result.error.issues.map((e) => {
                const path = e.path.length > 0 ? e.path.join(".") : "root";
                return `${path}: ${e.message}`;
            }),
        };
    }

    return { valid: true, data: result.data };
}

export function validateNameFolderMatch(name: string, folderName: string): boolean {
    return name === folderName;
}
