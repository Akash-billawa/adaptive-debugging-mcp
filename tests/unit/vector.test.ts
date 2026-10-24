import { describe, it, expect } from "bun:test";
import {
  cosineSimilarity,
  l2Normalize,
  LocalHashVectorizer,
  defaultVectorizer,
} from "../../src/retrieval/vector.ts";

describe("vector mathematics and hashing vectorizer", () => {
  it("cosineSimilarity: computes 1.0 for identical vectors and 0.0 for orthogonal", () => {
    const v1 = [1, 0, 0];
    const v2 = [1, 0, 0];
    const v3 = [0, 1, 0];

    expect(cosineSimilarity(v1, v2)).toBe(1.0);
    expect(cosineSimilarity(v1, v3)).toBe(0.0);
    expect(cosineSimilarity([], [])).toBe(0.0);
  });

  it("l2Normalize: normalizes vector length to 1.0", () => {
    const raw = [3, 4]; // norm = 5
    const norm = l2Normalize(raw);
    expect(norm[0]).toBeCloseTo(0.6, 2);
    expect(norm[1]).toBeCloseTo(0.8, 2);

    const len = Math.sqrt(norm[0] * norm[0] + norm[1] * norm[1]);
    expect(len).toBeCloseTo(1.0, 4);
  });

  it("LocalHashVectorizer: is deterministic", () => {
    const vectorizer = new LocalHashVectorizer();
    const text = "SQLiteError: database is locked during WAL checkpoint";
    const vec1 = vectorizer.embed(text);
    const vec2 = vectorizer.embed(text);

    expect(vec1.length).toBe(256);
    expect(vec2.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      expect(vec1[i]).toBe(vec2[i]);
    }
  });

  it("LocalHashVectorizer: captures morphological stems and subwords", () => {
    const vectorizer = defaultVectorizer;
    const v1 = vectorizer.embed("concurrency checkpoint error in sqlite");
    const v2 = vectorizer.embed("concurrent checkpointing errors in sqlite");
    const v3 = vectorizer.embed("unrelated css layout rendering color");

    const simRelated = cosineSimilarity(v1, v2);
    const simUnrelated = cosineSimilarity(v1, v3);

    expect(simRelated).toBeGreaterThan(0.7);
    expect(simUnrelated).toBeLessThan(0.3);
  });
});
