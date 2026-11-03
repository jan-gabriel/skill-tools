#!/usr/bin/env node
/**
 * skill-tools — single binary dispatcher
 *
 * Usage: skill-tools <command> [args...]
 *   validate   <skills-root>          — validate all SKILL.md files
 *   ingest     <source-dir> [root]    — ingest raw skills into skills/ tree
 *   scan-scores <skills-root> [out]   — security scan all skills, write scores.json
 *   review     [skills-root] [out.md] — generate corpus review report
 */

const command = process.argv[2];

if (!command || command === "--help" || command === "-h") {
    console.log(`skill-tools <command> [args...]

Commands:
  validate    <skills-root>           Validate all SKILL.md files
  ingest      <source-dir> [root]     Ingest raw skills into skills/ tree
  scan-scores <skills-root> [out]     Security scan all skills, write scores.json
  review      [skills-root] [out.md]  Generate corpus review report
`);
    process.exit(command ? 0 : 1);
}

// Strip the command from argv so each sub-CLI sees normal positional args
process.argv.splice(2, 1);

switch (command) {
    case "validate":
        await import("./validate.js");
        break;
    case "ingest":
        await import("./ingest.js");
        break;
    case "scan-scores":
        await import("./scan-scores.js");
        break;
    case "review":
        await import("./review.js");
        break;
    default:
        console.error(`skill-tools: unknown command "${command}"`);
        console.error("Run skill-tools --help for usage.");
        process.exit(1);
}
