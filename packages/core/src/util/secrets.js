// Secret detection & redaction. Used by long-term memory (never persist secrets), by the GitHub
// publishing workflow (never push secrets), and by tool output scrubbing.
const RULES = [
  ["aws-access-key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github-token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g],
  ["github-fine-grained", /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["stripe-key", /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{20,}\b/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["url-credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]{3,}@[^\s/]+/gi],
  ["generic-assignment", /\b(?:api[_-]?key|secret|token|passwd|password|auth[_-]?token|access[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi],
];
const WEAK = /^(?:password|passwd|secret|token|changeme|example|test|dummy|default|admin|letmein|hunter2)\w{0,4}$/i;
const PLACEHOLDER = /^(?:x{4,}|\*{4,}|<[^>]+>|\$\{[^}]+\}|process\.env\.\w+|your[_-]?\w*|example|changeme|placeholder|todo|\.{3})$/i;

/** @returns {{type:string, line:number, preview:string, index:number}[]} (previews are redacted) */
export function detectSecrets(text) {
  const out = [];
  for (const [type, re] of RULES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const val = m[1] ?? m[0];
      if (PLACEHOLDER.test(val) || /^(?:true|false|null|undefined)$/i.test(val)) continue;
      if (type === "generic-assignment" && (shannon(val) < 2.5 || WEAK.test(val))) continue; // "password: 'password'" style fixtures
      out.push({ type, line: text.slice(0, m.index).split("\n").length, index: m.index, preview: redactValue(val) });
    }
  }
  return out;
}
export function redactSecrets(text) {
  let out = text;
  for (const [type, re] of RULES) {
    re.lastIndex = 0;
    out = out.replace(re, (full, g1) => {
      const val = g1 ?? full; if (PLACEHOLDER.test(val) || (type === "generic-assignment" && (shannon(val) < 2.5 || WEAK.test(val)))) return full;
      return g1 ? full.replace(g1, `[REDACTED:${type}]`) : `[REDACTED:${type}]`;
    });
  }
  return out;
}
const redactValue = (v) => (v.length <= 8 ? "****" : v.slice(0, 3) + "…" + "*".repeat(4));
function shannon(s) { const f = {}; for (const c of s) f[c] = (f[c] ?? 0) + 1; let h = 0; for (const k in f) { const p = f[k] / s.length; h -= p * Math.log2(p); } return h; }

/** Files that should never be committed/published regardless of content. */
export const SENSITIVE_FILENAMES = [/(^|\/)\.env(\..+)?$/, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, /\.(pem|p12|pfx|keystore|jks)$/, /(^|\/)\.npmrc$/, /(^|\/)\.pypirc$/, /(^|\/)credentials(\.json)?$/, /(^|\/)\.aws\/credentials$/, /(^|\/)secrets?\.(json|ya?ml|toml)$/];
export const isSensitiveFilename = (p) => SENSITIVE_FILENAMES.some((r) => r.test(p)) && !/\.(example|sample|template)$/.test(p);
