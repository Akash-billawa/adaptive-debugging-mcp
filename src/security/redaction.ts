import type { RedactionStatus } from "../vocab.ts";

/**
 * Secret redaction.
 *
 * All evidence text must be redacted before it is persisted or indexed. Patterns
 * below intentionally favour over-redaction of credentials over leakage. The
 * redaction is lossy and non-reversible by design; we only record *that* it
 * occurred, never the secret.
 */

export interface RedactionResult {
  text: string;
  kinds: string[];
  status: RedactionStatus; // "redacted" if any replaced, else "no_secret_detected"
}

interface Rule {
  name: string;
  re: RegExp;
  replacement: string | ((...m: string[]) => string);
}

const RULES: Rule[] = [
  { name: "private_key_block", re: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, replacement: "[REDACTED:private_key_block]" },

  // Cloud provider keys
  { name: "aws_access_key_id", re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED:aws_access_key_id]" },
  { name: "aws_secret_context", re: /(\baws_secret_access_key\b|\baws_secret\b)(\s*[:=]\s*)(["']?)([^\s"',;]{8,})(["']?)/gi, replacement: (_f, k, sep, q1, _v, q2) => `${k}${sep}${q1}[REDACTED:aws_secret]${q2}` },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/g, replacement: "[REDACTED:google_api_key]" },

  // Common API/token prefixes
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, replacement: "[REDACTED:github_token]" },
  { name: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, replacement: "[REDACTED:github_pat]" },
  { name: "openai_key", re: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED:openai_key]" },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED:slack_token]" },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, replacement: "[REDACTED:jwt]" },
  { name: "azure_connection_string", re: /(\bAccountKey\s*=\s*)([^;\s]+)/gi, replacement: (_f, k, _v) => `${k}[REDACTED:account_key]` },
  { name: "connection_password", re: /((?:password|pwd)\s*=\s*)([^;\s&]+)/gi, replacement: (_f, k, _v) => `${k}[REDACTED:password]` },
  { name: "sas_sig", re: /(\bsig\s*=\s*)([^&\s]+)/gi, replacement: (_f, k, _v) => `${k}[REDACTED:sas_sig]` },

  // Authorization: Bearer <token>
  { name: "bearer_token", re: /(\bauthorization\b\s*[:=]\s*bearer\s+)([A-Za-z0-9\-._~+/]+=*)/gi, replacement: (_f, k, _v) => `${k}[REDACTED:bearer_token]` },

  // Generic key=value style secrets
  {
    name: "generic_kv_secret",
    re: /\b(token|secret|password|passwd|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|refresh[_-]?token|session[_-]?token)\b(\s*[:=]\s*)(["']?)([^\s"',;}]{4,})\3/gi,
    replacement: (_f, k, sep, q) => `${k}${sep}${q}[REDACTED:${k.toLowerCase().replace(/[_\s]+/g, "_")}]${q}`,
  },
];

/** Apply all redaction rules. Returns redacted text and detected kinds. */
export function redact(input: string): RedactionResult {
  let text = input;
  const kinds = new Set<string>();
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args) => {
      const groups = args.slice(0, -2) as string[];
      if (!kinds.has(rule.name)) kinds.add(rule.name);
      if (typeof rule.replacement === "function") {
        return rule.replacement(...groups);
      }
      return rule.replacement;
    });
  }
  const detected = [...kinds];
  return {
    text,
    kinds: detected,
    status: detected.length > 0 ? "redacted" : "no_secret_detected",
  };
}

/**
 * Redact only when text actually changed; keep prior status if input was empty.
 * Use this to compute the redaction_status to persist alongside the content.
 */
export function redactWithStatus(input: string): RedactionResult {
  if (!input) return { text: input, kinds: [], status: "no_secret_detected" };
  return redact(input);
}
