// src/skill-schema.ts
import { z } from "zod";
var KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
var SEMVER_RE = /^\d+\.\d+\.\d+$/;
var SkillRequiresSchema = z.object({
  mcp_servers: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([])
});
var SkillSourceSchema = z.enum(["official", "curated", "community"]);
var SkillFrontmatterSchema = z.object({
  name: z.string().min(1).regex(KEBAB_RE, "name must be kebab-case (lowercase letters, digits, hyphens only)"),
  description: z.string().max(200, "description must be \u2264 200 characters"),
  domain: z.string().min(1),
  tags: z.array(z.string()).default([]),
  requires: SkillRequiresSchema.default({ mcp_servers: [], tools: [] }),
  version: z.string().regex(SEMVER_RE, "version must be semver (e.g. 0.1.0)").default("0.1.0"),
  source: SkillSourceSchema.default("curated"),
  review_status: z.enum(["pending", "approved"]).optional()
});
var MIN_BODY_CHARS = 50;
function validateSkill(frontmatter, body) {
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
      })
    };
  }
  return { valid: true, data: result.data };
}
function validateNameFolderMatch(name, folderName) {
  return name === folderName;
}

export {
  SkillRequiresSchema,
  SkillSourceSchema,
  SkillFrontmatterSchema,
  validateSkill,
  validateNameFolderMatch
};
