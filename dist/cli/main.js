#!/usr/bin/env node

// src/cli/main.ts
var command = process.argv[2];
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
process.argv.splice(2, 1);
switch (command) {
  case "validate":
    await import("../validate-3SSX6IC7.js");
    break;
  case "ingest":
    await import("../ingest-IAMEGDGW.js");
    break;
  case "scan-scores":
    await import("../scan-scores-IS2N7RPG.js");
    break;
  case "review":
    await import("../review-KBEZDER6.js");
    break;
  default:
    console.error(`skill-tools: unknown command "${command}"`);
    console.error("Run skill-tools --help for usage.");
    process.exit(1);
}
