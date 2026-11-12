// src/skill-schema.ts
import { z } from "zod";
var KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
var SEMVER_RE = /^\d+\.\d+\.\d+$/;
var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidIsoDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
var LastVerifiedSchema = z.string().regex(ISO_DATE_RE, "last_verified must be an ISO 8601 date (YYYY-MM-DD)").refine(isValidIsoDate, "last_verified must be a real calendar date");
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
  review_status: z.enum(["pending", "approved"]).optional(),
  last_verified: LastVerifiedSchema.optional()
}).superRefine((fm, ctx) => {
  if (fm.review_status === "approved" && fm.last_verified === void 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["last_verified"],
      message: "last_verified (ISO date) is required when review_status is approved"
    });
  }
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
  isValidIsoDate,
  LastVerifiedSchema,
  SkillRequiresSchema,
  SkillSourceSchema,
  SkillFrontmatterSchema,
  validateSkill,
  validateNameFolderMatch
};
