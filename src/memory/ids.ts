/** Stable identifiers and derived display labels. */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const TYPES: Record<string, string> = {
  project: "prj",
  incident: "inc",
  fingerprint: "fpr",
  environment: "env",
  hypothesis: "hyp",
  strategy: "str",
  experiment: "exp",
  evidence: "evd",
  research: "res",
  validation: "val",
  event: "evt",
  link: "lnk",
  approval: "apr",
};

function randomBase36(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % 36];
  return out;
}

/** Generate a stable, sortable-ish identifier for a record type. */
export function newId(type: keyof typeof TYPES): string {
  const prefix = TYPES[type] ?? "rec";
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${randomBase36(10)}`;
}

/** Convenience wrappers. */
export const ids = {
  project: () => newId("project"),
  incident: () => newId("incident"),
  fingerprint: () => newId("fingerprint"),
  environment: () => newId("environment"),
  hypothesis: () => newId("hypothesis"),
  strategy: () => newId("strategy"),
  experiment: () => newId("experiment"),
  evidence: () => newId("evidence"),
  research: () => newId("research"),
  validation: () => newId("validation"),
  event: () => newId("event"),
  link: () => newId("link"),
  approval: () => newId("approval"),
};

/** Content hash (non-cryptographic integrity check). Returns a numeric string. */
export function contentHash(text: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h1 ^= text.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return String(h1 >>> 0);
}

// --- Display labels --------------------------------------------------------
// Bijective base-26: 0->A, 1->B, ..., 25->Z, 26->AA ...
function bijectiveLetters(n: number): string {
  let s = "";
  n = n + 1; // 1-based bijective
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = LETTERS[rem] + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Derive a human-readable display label from a parent label and the count of
 * existing siblings that share the same parent. Depth parity selects whether the
 * appended segment is a letter (even depth) or a number (odd depth), producing
 * labels such as A, A1, A1A, A1A1 without any fixed-depth schema.
 *
 * @param parentLabel parent's display label, or null for a root node
 * @param siblingCount number of existing siblings sharing the same parent (>= 0)
 * @param depth depth of the NEW node (number of ancestors); root = 0
 */
export function deriveLabel(
  parentLabel: string | null,
  siblingCount: number,
  depth: number,
): string {
  const useLetter = depth % 2 === 0; // root(0)=letters, depth1=numbers, depth2=letters...
  const segment = useLetter ? bijectiveLetters(siblingCount) : String(siblingCount + 1);
  return parentLabel ? `${parentLabel}${segment}` : segment;
}
