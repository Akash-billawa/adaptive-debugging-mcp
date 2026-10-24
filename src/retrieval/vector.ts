/**
 * Vector mathematics and deterministic local embedding vectorizer.
 * Zero external dependencies; runs offline in pure TypeScript across all platforms.
 */

export interface EmbeddingProvider {
  readonly modelName: string;
  readonly dimension: number;
  embed(text: string): number[];
}

/**
 * Computes cosine similarity between two numeric vectors.
 * Returns a value between -1.0 and 1.0 (clamped to [0.0, 1.0] for non-negative vectors).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA <= 0 || normB <= 0) return 0;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  const sim = dotProduct / denom;
  return Math.max(0, Math.min(1, Number(sim.toFixed(4))));
}

/**
 * L2-normalizes a numeric vector.
 */
export function l2Normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  if (sumSq <= 0) return vec.slice();
  const norm = Math.sqrt(sumSq);
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

/**
 * 32-bit FNV-1a string hash function.
 */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic local subword and token n-gram feature hashing vectorizer.
 * Captures semantics, error signatures, symbols, typos, and morphologic stems
 * without requiring any external neural network weight downloads.
 */
export class LocalHashVectorizer implements EmbeddingProvider {
  readonly modelName = "local-subword-hash-256";
  readonly dimension = 256;

  embed(text: string): number[] {
    const raw = (text ?? "").trim().toLowerCase();
    if (!raw) {
      return new Array(this.dimension).fill(0);
    }

    const vector = new Float64Array(this.dimension);

    // 1. Split into words and identifier tokens
    const words = raw
      .replace(/['"`()[\]{}<>:;,=]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0);

    for (const word of words) {
      // Token-level feature
      const hWord = fnv1a(word);
      const idxWord = hWord % this.dimension;
      const signWord = (hWord & 1) === 0 ? 1 : -1;
      vector[idxWord] += signWord * 2.0; // Higher weight for whole tokens

      // Character n-grams (3-grams, 4-grams, 5-grams)
      if (word.length >= 3) {
        for (let n = 3; n <= Math.min(5, word.length); n++) {
          for (let i = 0; i <= word.length - n; i++) {
            const ngram = word.slice(i, i + n);
            const hNgram = fnv1a(ngram);
            const idxNgram = hNgram % this.dimension;
            const signNgram = (hNgram & 1) === 0 ? 1 : -1;
            vector[idxNgram] += signNgram * 1.0;
          }
        }
      }
    }

    return l2Normalize(Array.from(vector));
  }
}

export const defaultVectorizer = new LocalHashVectorizer();
