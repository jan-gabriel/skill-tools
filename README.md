# skill-tools

SKILL.md contract and tooling for curating AI agent skills.

A small TypeScript library plus CLI for validating, ingesting, security-scanning and reviewing a corpus of `SKILL.md` skills. Zero runtime dependencies beyond `zod` and `gray-matter`; deterministic and offline by default.

## Install

```bash
pnpm install
pnpm build
```

Requires Node.js >= 20.

## CLI

```bash
skill-tools <command> [args...]
```

| Command | Description |
| --- | --- |
| `validate <skills-root>` | Validate every `SKILL.md` under the root: schema, `name` == folder, security lints, and the full security scanner over `SKILL.md` plus all companion files. |
| `ingest <source-dir> [skills-root]` | Ingest raw skills (folders with `SKILL.md`, or flat `*.skill.md` / `*.md`) into a `skills/<domain>/<name>/` tree. Derives metadata and marks everything `review_status: pending`. |
| `scan-scores <skills-root> [out]` | Security-scan all skills and write `scores.json` with `{ score, tier, findings }` per skill. |
| `review [skills-root] [out.md]` | Generate a Markdown corpus review report: security tiers, metadata warnings, broken references, and near-duplicate clusters. Reports only — never edits or approves. |

Run `skill-tools --help` for the built-in usage text.

### Ingest input layout

```text
source/
  official/<skill>/SKILL.md
  curated/<skill>/SKILL.md
  community/<skill>/SKILL.md
```

The first path segment below the source directory (`official`, `curated`, `community`) is used as the skill's provenance. Companion files (`scripts/`, `references/`, `assets/`, etc.) are copied through intact. Set `ANTHROPIC_API_KEY` to enable optional LLM-assisted description generation; otherwise heuristics are used.

## Library

```ts
import {
  validateSkill,
  scanSecurity,
  scanSecurityFiles,
  classifyTier,
  ingestDirectory,
  generateBM25Embedding,
} from "skill-tools";
```

### Schema

`SkillFrontmatterSchema` (zod) requires:

| Field | Rules |
| --- | --- |
| `name` | kebab-case, must match the folder name |
| `description` | required, max 200 characters |
| `domain` | required, non-empty |
| `tags` | string[] (default `[]`) |
| `requires` | `{ mcp_servers: string[], tools: string[] }` |
| `version` | semver, default `0.1.0` |
| `source` | `official` \| `curated` \| `community`, default `curated` |
| `review_status` | `pending` \| `approved` (optional) |
| `last_verified` | ISO date `YYYY-MM-DD` (real calendar date); **required when `review_status: approved`**, optional otherwise |

The Markdown body must be at least 50 characters.

Approval is gated on provenance: a skill marked `review_status: approved` **must** carry a `last_verified` ISO date (the date the content was last reviewed or changed). `last_verified` must be a real calendar date (`2026-11-04`), never a timestamp; validation rejects an approved skill without one. The ingest CLI preserves a valid `last_verified` through a round-trip and never invents a date for `pending` skills.

### Security scanning

`scanSecurity` matches 11 threat categories (command injection, data exfiltration, credential harvesting, prompt injection, obfuscation, sensitive-file access, external calls, destructive commands, reverse shell, social engineering, supply chain) and scores each file:

```
score = max(0, 100 − (CRIT×20 + HIGH×10 + MED×3 + LOW×1))
5+ CRIT findings → score = 0
```

`scanSecurityFiles` aggregates findings across a skill's whole directory (weakest-link scoring) and `classifyTier` maps the result to:

- `safe` — score >= 80 and zero CRIT findings
- `review` — score 50–79 or exactly 1 CRIT finding
- `unsafe` — score < 50 or 2+ CRIT findings (fails `validate`)

### BM25 embeddings

`generateBM25Embedding(text)` produces a deterministic 384-dimension sparse embedding (djb2-hashed term frequencies, L2-normalised). No model download required; used by `review` for near-duplicate detection.

### Shared MCP contract fixture

`contract/contract-v1.json` is the single authored description of the MCP contract
(tool names and inputs, the trust envelope, error codes, the publication gate, and
the `content_hash` rules). It ships with this package so both consumers can assert
against the **same file at the same tag** instead of keeping private copies:

- `auto-discover-mcp` asserts the server implements it
  (`packages/discovery/tests/contract/contract-v1.test.ts`);
- `agent-skill-corpus` asserts its published site copy matches it
  (`site/src/lib/mcp-contract.test.ts` and the post-build contract gate).

Resolve it from a dependency rather than copying it:

```js
const fixture = JSON.parse(readFileSync(
  createRequire(import.meta.url).resolve("skill-tools/contract/contract-v1.json"),
  "utf-8",
));
```

Bump `contract_version` inside the fixture only alongside a release, per the
N/N-1 compatibility policy.

## Development

```bash
pnpm test    # vitest
pnpm lint    # tsc --noEmit
pnpm build   # tsup → dist/
```

The built `dist/` is committed so the package can be consumed as a git dependency without a build step.
