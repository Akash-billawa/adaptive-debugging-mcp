/**
 * Error fingerprint normalization.
 *
 * Recurring failures often carry volatile text (paths, timestamps, ports, UUIDs,
 * hashes). Normalization produces a stable fingerprint so equivalent errors can be
 * matched, while the ORIGINAL raw text is always retained separately as evidence.
 * A fingerprint match is a candidate relationship, never proof of identical cause.
 */

export const NORMALIZATION_VERSION = "v1";

const RULES: [RegExp, string][] = [
  // Windows path (drive letter) INCLUDING trailing :line[:col]
  [/[A-Za-z]:\\[^\s]+/g, "<PATH>"],
  // POSIX absolute path including optional :line[:col]
  [/(?:\/[\w.\-]+)+\/?(?::\d+(?::\d+)?)?/g, "<PATH>"],
  // Relative source file with location (e.g. src/foo.ts:12:5, main.js:3)
  [/\b[\w\-./\\]+\.(?:js|ts|tsx|jsx|mjs|cjs|py|go|rs|java|rb|kt|swift|scala|cs|cc|cpp|hpp|c|h|php)\b(?::\d+(?::\d+)?)?/gi, "<FILE>"],
  // UUIDs / GUIDs
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "<UUID>"],
  // ISO / common timestamps
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<TIME>"],
  [/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<TIME>"],
  // IPv4 (:port) — consumes the port with the address
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<IP>"],
  // Remaining bare :line or :line:col locations
  [/:\d+(?::\d+)?/g, "<LOC>"],
  // Hex hashes (>= 8 hex chars, includes all-digit runs that look like hashes/ids)
  [/\b[0-9a-fA-F]{8,}\b/g, "<HEX>"],
  // Remaining long decimal numbers (ids, offsets, counts); short ones like 404/500 are kept
  [/\d{4,}/g, "<NUM>"],
];

/** Normalize an error message or symptom into a stable fingerprint string. */
export function normalizeMessage(text: string): string {
  let s = text ?? "";
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, 512);
}

/**
 * Extract a stack-trace signature: the ordered list of frame identifiers with
 * line/column numbers stripped, so the same failure across different line numbers
 * still matches. Supports Node ("at fn (file:l:c)"), Python ("File \"x\", line N, in f"),
 * and generic "in fn" frames. Returns "" when no frames are detected.
 */
export function stackSignature(text: string): string {
  const lines = (text ?? "").split(/\r?\n/);
  const frames: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    let m = line.match(/^at\s+(?:async\s+)?([\w$.<>]+)\s*\(/); // at fn (file:l:c)
    if (m) { frames.push(m[1]); continue; }
    m = line.match(/^at\s+(?:async\s+)?(.+)$/); // at file:l:c (anonymous)
    if (m) { frames.push(m[1].replace(/:\d+(:\d+)?$/,"")); continue; }
    m = line.match(/in\s+([\w$.<>]+)\s*$/); // python: File "x", line N, in f
    if (m) { frames.push(m[1]); continue; }
  }
  return frames.slice(0, 40).join("|");
}

export interface FingerprintResult {
  normalized: string;
  signature: string;
  version: string;
}

/** Produce all fingerprints derived from a raw error text. */
export function computeFingerprints(rawError: string): FingerprintResult {
  return {
    normalized: normalizeMessage(rawError),
    signature: stackSignature(rawError),
    version: NORMALIZATION_VERSION,
  };
}

export function buildFingerprintValues(rawError: string): { fingerprint_type: string; fingerprint_value: string; normalization_version: string }[] {
  const { normalized, signature, version } = computeFingerprints(rawError);
  const out: { fingerprint_type: string; fingerprint_value: string; normalization_version: string }[] = [];
  if (normalized) out.push({ fingerprint_type: "normalized_message", fingerprint_value: normalized, normalization_version: version });
  if (signature) out.push({ fingerprint_type: "stack_signature", fingerprint_value: signature, normalization_version: version });
  return out;
}
