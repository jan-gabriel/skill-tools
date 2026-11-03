import type { SkillFrontmatter } from "./skill-schema.js";

export interface IngestedSkill {
    frontmatter: SkillFrontmatter;
    body: string;
    outputDir: string;
    outputPath: string;
    sourceFile: string;
    warnings: string[];
}
