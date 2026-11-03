// src/security-scan.ts
function classifyTier(score, findings) {
  const critCount = findings.filter((f) => f.severity === "CRIT").length;
  if (score < 50 || critCount >= 2) return "unsafe";
  if (score < 80 || critCount >= 1) return "review";
  return "safe";
}
var SEVERITY_WEIGHTS = {
  CRIT: 20,
  HIGH: 10,
  MED: 3,
  LOW: 1
};
var PATTERNS = [
  // ── CRITICAL ──────────────────────────────────────────────────────────────
  {
    // Reverse shells: interactive bash/sh piped to network socket
    category: "reverse-shell",
    severity: "CRIT",
    regex: /bash\s+-i\s+>&?\s+\/dev\/tcp|nc\s+(-e|-c)\s+[/]bin\/(ba)?sh|socat.*exec[^,]*sh|python[23]?\s+-c['"]\s*import\s+socket.*connect/i
  },
  {
    // Supply chain: download-and-execute (curl/wget piped directly to interpreter)
    category: "supply-chain",
    severity: "CRIT",
    regex: /curl\b[^|"'\n]*\|\s*(ba)?sh\b|curl\b[^|"'\n]*\|\s*(python|node|ruby|perl)\b/i
  },
  {
    category: "supply-chain",
    severity: "CRIT",
    regex: /wget\b[^|"'\n]*\|\s*(ba)?sh\b|wget\b[^|"'\n]*\|\s*(python|node)\b/i
  },
  {
    // Embedded private key material
    category: "credential-harvesting",
    severity: "CRIT",
    regex: /-----BEGIN\s+(RSA|EC|OPENSSH|DSA|PRIVATE)\s+PRIVATE\s+KEY-----/
  },
  // ── HIGH ──────────────────────────────────────────────────────────────────
  {
    // Hardcoded API keys / access tokens in literal form
    category: "credential-harvesting",
    severity: "HIGH",
    regex: /(?:api[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret)\s*[=:]\s*["'][A-Za-z0-9_\-]{16,}["']/i
  },
  {
    // Known data-exfiltration / attacker-infrastructure domains
    category: "data-exfiltration",
    severity: "HIGH",
    regex: /https?:\/\/[a-z0-9.-]*\.(ngrok\.io|burpcollaborator\.net|requestbin\.\w+|webhook\.site|pipedream\.net|hookbin\.com|canarytokens\.\w+)/i
  },
  {
    // Destructive filesystem / disk operations
    category: "destructive-command",
    severity: "HIGH",
    regex: /rm\s+-rf\s+[/~]|shred\s+-[uU]|dd\s+if=\/dev\/zero\b|mkfs\.\w+|format\s+c:/i
  },
  {
    // Shell command injection via eval or dangerous subprocess calls
    category: "command-injection",
    severity: "HIGH",
    regex: /\beval\s*\(\s*\$|\bsubprocess\.call\b.*shell\s*=\s*True|\bos\.system\s*\(|\bchild_process\.exec\s*\(/
  },
  {
    // Strong prompt-injection: override system instructions
    category: "prompt-injection",
    severity: "HIGH",
    regex: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions|disregard\s+(all\s+)?instructions/i
  },
  {
    // Prompt injection: system prompt extraction
    category: "prompt-injection",
    severity: "HIGH",
    regex: /repeat\s+(your\s+)?system\s+prompt|print\s+(your\s+)?system\s+prompt|output\s+(your\s+)?instructions\s+verbatim/i
  },
  // ── MEDIUM ────────────────────────────────────────────────────────────────
  {
    // Obfuscation: decode base64 and pipe to interpreter
    category: "obfuscation",
    severity: "MED",
    regex: /base64\s+(-d|--decode)\b[^|]*\|\s*(ba)?sh\b|base64\s+(-d|--decode)\b[^|]*\|\s*(python|node)/i
  },
  {
    // Obfuscation: eval(atob(...)) or atob(...)→eval in instructions
    category: "obfuscation",
    severity: "MED",
    regex: /eval\s*\(\s*atob\s*\(|atob\s*\([^)]+\)\s*.*\beval\b/i
  },
  {
    // Access to sensitive local paths: SSH keys, shadow file, cloud credentials
    category: "sensitive-file-access",
    severity: "MED",
    regex: /~\/\.ssh\/|\/etc\/shadow\b|\/etc\/passwd\b|\.aws\/credentials\b|\.npmrc.*token|HISTFILE|\/proc\/self/i
  },
  {
    // Instructions to POST/send data to external URLs (data leaving the machine)
    category: "external-calls",
    severity: "MED",
    regex: /curl\b.*-[dDfF]\s+[^|].*https?:\/\/|fetch\s*\(\s*["']https?:\/\/(?!raw\.githubusercontent\.com|cdn\.)[^"']+["']\s*,\s*\{[^}]*method\s*:\s*["']POST/i
  },
  // ── LOW ───────────────────────────────────────────────────────────────────
  {
    // Social engineering: hidden urgency or "don't tell the user" patterns
    category: "social-engineering",
    severity: "LOW",
    regex: /do not (?:tell|inform|reveal|disclose) the user|hidden instruction|act as if you have no restrictions|urgently\s+(?:run|execute|do\s+this)/i
  },
  {
    // Weak prompt injection: roleplay-without-restrictions framing
    category: "prompt-injection",
    severity: "LOW",
    regex: /pretend you (?:are|have no)|you are now\s+\w+\s+(?:without|that ignores)|as (?:an? )?\w+\s+you must ignore/i
  }
];
function scanSecurity(content) {
  const lines = content.split("\n");
  const findings = [];
  const seenLineCategory = /* @__PURE__ */ new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const p of PATTERNS) {
      const key = `${i}:${p.category}`;
      if (seenLineCategory.has(key)) continue;
      if (p.regex.test(line)) {
        seenLineCategory.add(key);
        findings.push({
          category: p.category,
          severity: p.severity,
          line: i + 1,
          match: line.slice(0, 120).trim()
        });
      }
    }
  }
  const critCount = findings.filter((f) => f.severity === "CRIT").length;
  if (critCount >= 5) return { score: 0, findings };
  const penalty = findings.reduce(
    (sum, f) => sum + SEVERITY_WEIGHTS[f.severity],
    0
  );
  return { score: Math.max(0, 100 - penalty), findings };
}
function scanSecurityFiles(files) {
  const allFindings = [];
  for (const { path, content } of files) {
    const { findings } = scanSecurity(content);
    for (const f of findings) {
      allFindings.push({ ...f, file: path });
    }
  }
  const critCount = allFindings.filter((f) => f.severity === "CRIT").length;
  if (critCount >= 5) return { score: 0, findings: allFindings };
  const penalty = allFindings.reduce(
    (sum, f) => sum + SEVERITY_WEIGHTS[f.severity],
    0
  );
  return { score: Math.max(0, 100 - penalty), findings: allFindings };
}

export {
  classifyTier,
  scanSecurity,
  scanSecurityFiles
};
