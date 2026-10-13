import { test, expect } from "bun:test";
import { normalizeMessage, stackSignature, computeFingerprints, buildFingerprintValues } from "../../src/retrieval/fingerprint.ts";

test("normalizeMessage strips volatile parts but keeps stable text", () => {
  const a = normalizeMessage("Error at C:\\app\\src\\p.js:42:11 processing request 12345678 at 2026-10-12T10:00:00Z from 10.0.0.5:54321");
  const b = normalizeMessage("Error at C:\\other\\p.js:99:3 processing request 99999999 at 2027-01-01T00:00:00Z from 192.168.1.9:60000");
  expect(a).toBe(b); // volatile parts normalized away
  expect(a).toContain("processing request");
});

test("normalizeMessage keeps short status codes but hides long numbers", () => {
  const s = normalizeMessage("HTTP 500 after 120000ms for id 9f8e7d6c5b4a");
  expect(s).toContain("500");
  expect(s).toContain("<NUM>");
  expect(s).not.toContain("120000");
});

test("stackSignature extracts node frames and ignores line/col numbers", () => {
  const s1 = stackSignature("TypeError: x\n    at parse (C:\\a\\b.js:10:5)\n    at handler (C:\\a\\c.js:20:7)");
  const s2 = stackSignature("TypeError: y\n    at parse (C:\\z\\q.js:999:1)\n    at handler (C:\\z\\r.js:888:2)");
  expect(s1).toBe("parse|handler");
  expect(s1).toBe(s2); // same signature, different lines
});

test("empty input yields empty signature", () => {
  expect(stackSignature("no frames here")).toBe("");
});

test("buildFingerprintValues produces normalized + signature entries", () => {
  const raw = "TypeError: cannot read id\n    at parse (C:\\x\\y.js:3:1)";
  const fps = buildFingerprintValues(raw);
  const types = fps.map((f) => f.fingerprint_type);
  expect(types).toContain("normalized_message");
  expect(types).toContain("stack_signature");
  const norm = fps.find((f) => f.fingerprint_type === "normalized_message")!;
  expect(norm.normalization_version).toBe("v1");
  const sig = fps.find((f) => f.fingerprint_type === "stack_signature")!;
  expect(sig.fingerprint_value).toContain("parse");
});

test("computeFingerprints version stamped", () => {
  const r = computeFingerprints("boom");
  expect(r.version).toBe("v1");
  expect(r.normalized).toBe("boom");
});
