import type { RedactionStatus } from "../vocab.ts";

/**
 * Secret redaction.
 *
 * All evidence text and incoming inputs must be redacted before being persisted
 * or indexed. Patterns below intentionally favour over-redaction of credentials
 * over leakage. The redaction is lossy and non-reversible by design; we only
 * record *that* it occurred, never the secret.
 */

export interface RedactionResult {
  text: string;
  kinds: string[];
  status: RedactionStatus; // "redacted" if any replaced, else "no_secret_detected"
}

export interface RedactDeepResult<T = unknown> {
  value: T;
  fields: string[];
}

interface Rule {
  name: string;
  re: RegExp;
  replacement: string | ((...m: string[]) => string);
}

const RULES: Rule[] = [
  // 1. Private keys (complete or unterminated, including OpenSSH and RSA)
  {
    name: "private_key_block",
    re: /-----BEGIN [A-Z0-9 _-]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 _-]*PRIVATE KEY-----|$)/gi,
    replacement: "[REDACTED:private_key_block]",
  },

  // 2. URL credentials (e.g. postgres://user:pass@host, redis://:pass@host)
  {
    name: "url_credentials",
    re: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:\s\/@]+)?(:)([^@\s\/]+)(@)/gi,
    replacement: (_f, proto, user, sep, _pwd, at) => `${proto}${user ?? ""}${sep}[REDACTED:credentials]${at}`,
  },
  // 2b. curl -u credentials
  {
    name: "url_credentials",
    re: /(\bcurl\s+[^-\r\n]*-[a-zA-Z]*u\s+)([^:\s]+)?(:)([^@\s]+)/gi,
    replacement: (_f, pre, user, sep, _pwd) => `${pre}${user ?? ""}${sep}[REDACTED:credentials]`,
  },
  // 2c. URL query parameter access_token / api_key
  {
    name: "url_credentials",
    re: /([?&](?:access_token|api_key|token|auth_token)=)([^&\s"']+)/gi,
    replacement: (_f, pre, _val) => `${pre}[REDACTED:token]`,
  },

  // 3. Authorization header (Bearer, Basic, or bare, quoted or unquoted)
  {
    name: "authorization_header",
    re: /(["']?authorization["']?\s*[:=]\s*)(["']?)((?:bearer\s+|basic\s+)?)([A-Za-z0-9\-._~+/]{10,}=*)\2/gi,
    replacement: (_f, pre, q, scheme, _v) => `${pre}${q}${scheme}[REDACTED:authorization_header]${q}`,
  },
  // 3b. Bare long Bearer token (>= 20 chars)
  {
    name: "bearer_token",
    re: /\bBearer\s+([A-Za-z0-9\-._~+/]{20,}=*)\b/g,
    replacement: "Bearer [REDACTED:bearer_token]",
  },

  // 4. Cookie header
  {
    name: "cookie_header",
    re: /(["']?cookie["']?\s*[:=]\s*)(["']?)([^"'\r\n]+)\2/gi,
    replacement: (_f, pre, q) => `${pre}${q}[REDACTED:cookie]${q}`,
  },

  // 5. Specific token formats
  {
    name: "anthropic_key",
    re: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9\-_]{20,}\b/g,
    replacement: "[REDACTED:anthropic_key]",
  },
  {
    name: "openai_key",
    re: /(?<![A-Za-z0-9])sk-(?:proj-|admin-)?[A-Za-z0-9\-_]{20,}\b/g,
    replacement: "[REDACTED:openai_key]",
  },
  {
    name: "stripe_key",
    re: /(?<![A-Za-z0-9])sk_(?:live|test)_[0-9a-zA-Z]{24,}\b/g,
    replacement: "[REDACTED:stripe_key]",
  },
  {
    name: "slack_webhook",
    re: /https:\/\/hooks\.slack\.com\/services\/T[0-9a-zA-Z]+\/B[0-9a-zA-Z]+\/[0-9a-zA-Z]{20,}/g,
    replacement: "[REDACTED:slack_webhook]",
  },
  {
    name: "slack_token",
    re: /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[REDACTED:slack_token]",
  },
  {
    name: "npm_token",
    re: /(\/\/registry\.npmjs\.org\/:_authToken\s*[:=]\s*)([^\s\r\n]+)/gi,
    replacement: (_f, pre) => `${pre}[REDACTED:npm_token]`,
  },
  {
    name: "npm_token",
    re: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36,}\b/g,
    replacement: "[REDACTED:npm_token]",
  },
  {
    name: "gitlab_token",
    re: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9\-_]{20,}\b/g,
    replacement: "[REDACTED:gitlab_token]",
  },
  {
    name: "github_token",
    re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}\b/g,
    replacement: "[REDACTED:github_token]",
  },
  {
    name: "github_pat",
    re: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{22,}\b/g,
    replacement: "[REDACTED:github_pat]",
  },
  {
    name: "aws_access_key_id",
    re: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED:aws_access_key_id]",
  },
  {
    name: "aws_secret_context",
    re: /((?<![A-Za-z0-9])aws_secret_access_key\b|(?<![A-Za-z0-9])aws_secret\b)(\s*[:=]\s*)(["']?)([^\s"',;]{8,})\3/gi,
    replacement: (_f, k, sep, q) => `${k}${sep}${q}[REDACTED:aws_secret]${q}`,
  },
  {
    name: "google_api_key",
    re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z\-_]{35}\b/g,
    replacement: "[REDACTED:google_api_key]",
  },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    replacement: "[REDACTED:jwt]",
  },
  {
    name: "azure_connection_string",
    re: /((?<![A-Za-z0-9])AccountKey\s*[:=]\s*)(["']?)([^;\s"']+)\2/gi,
    replacement: (_f, k, q) => `${k}${q}[REDACTED:account_key]${q}`,
  },
  {
    name: "connection_password",
    re: /((?<![A-Za-z0-9])(?:password|pwd)\s*[:=]\s*)(["']?)([^;\s&"']+)\2/gi,
    replacement: (_f, k, q) => `${k}${q}[REDACTED:password]${q}`,
  },
  {
    name: "sas_sig",
    re: /((?<![A-Za-z0-9])sig\s*[:=]\s*)(["']?)([^&\s"']+)\2/gi,
    replacement: (_f, k, q) => `${k}${q}[REDACTED:sas_sig]${q}`,
  },

  // 6. Generic key=value, JSON, and environment variables
  {
    name: "generic_kv_secret",
    re: /(["']?)(?<![A-Za-z0-9_])(?!max_)(?!total_)([A-Za-z0-9_]*?(?:password|passwd|secret|api[_-]?key|apikey|client[_-]?secret|auth[_-]?token|access[_-]?token|private[_-]?key|[A-Za-z0-9_]+token)\b|token)\1(\s*[:=]\s*)(?:(["'])(.*?)\4|(?![0-9]+\b)([^\s"',;}]{4,}))/gi,
    replacement: (_f, q1, k, sep, q2, _vQuoted, _vUnquoted) => {
      const q = q2 ?? "";
      return `${q1}${k}${q1}${sep}${q}[REDACTED:${k.toLowerCase().replace(/[^a-z0-9]+/g, "_")}]${q}`;
    },
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

const SECRET_KEY_NAME_RE = /(?:password|passwd|secret|api[_-]?key|apikey|token|auth[_-]?token|access[_-]?token|client[_-]?secret|private[_-]?key)$/i;
const NON_SECRET_KEY_NAME_RE = /^(?:max|total|count|num|prompt|completion)[_-]?tokens?$/i;

/**
 * Deeply traverses an object or array and redacts all nested string values
 * as well as values assigned to keys whose names indicate secret credentials.
 * Input data is not mutated.
 */
export function redactDeep<T>(
  input: T,
  opts?: { skip?: (path: string) => boolean }
): RedactDeepResult<T> {
  const changedPaths: string[] = [];
  const skipFn = opts?.skip;

  function isSecretKey(key: string): boolean {
    if (NON_SECRET_KEY_NAME_RE.test(key)) return false;
    return SECRET_KEY_NAME_RE.test(key);
  }

  function walk(val: unknown, currentPath: string, keyName?: string): unknown {
    if (currentPath && skipFn?.(currentPath)) {
      return val;
    }

    if (val === null || val === undefined || typeof val !== "object") {
      if (typeof val === "string") {
        if (keyName && isSecretKey(keyName)) {
          changedPaths.push(currentPath);
          return `[REDACTED:${keyName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}]`;
        }
        const res = redact(val);
        if (res.status === "redacted") {
          changedPaths.push(currentPath);
          return res.text;
        }
        return val;
      }
      return val;
    }

    if (Array.isArray(val)) {
      return val.map((item, idx) => {
        const itemPath = currentPath ? `${currentPath}[${idx}]` : `[${idx}]`;
        return walk(item, itemPath, undefined);
      });
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const childPath = currentPath ? `${currentPath}.${k}` : k;
      out[k] = walk(v, childPath, k);
    }
    return out;
  }

  const result = walk(input, "", undefined) as T;
  return { value: result, fields: changedPaths };
}
