import { test, expect } from "bun:test";
import { deriveLabel, contentHash, newId, ids } from "../../src/memory/ids.ts";

test("deriveLabel produces canonical A / A1 / A1A sequence by depth", () => {
  expect(deriveLabel(null, 0, 0)).toBe("A");      // first strategy root
  expect(deriveLabel(null, 1, 0)).toBe("B");      // second strategy root
  expect(deriveLabel("A", 0, 1)).toBe("A1");      // first experiment under A
  expect(deriveLabel("A", 1, 1)).toBe("A2");      // second experiment under A
  expect(deriveLabel("A1", 0, 2)).toBe("A1A");    // first variant under A1
  expect(deriveLabel("A1", 1, 2)).toBe("A1B");    // second variant under A1
  expect(deriveLabel("A1A", 0, 3)).toBe("A1A1");  // deeper nesting alternates
});

test("deriveLabel extends to A1AA:1-style deep nesting", () => {
  expect(deriveLabel("A1A1", 0, 4)).toBe("A1A1A");
});

test("bijective letters continue past Z", () => {
  expect(deriveLabel(null, 25, 0)).toBe("Z");
  expect(deriveLabel(null, 26, 0)).toBe("AA");
  expect(deriveLabel(null, 27, 0)).toBe("AB");
});

test("contentHash is a stable numeric string", () => {
  const h1 = contentHash("hello world");
  const h2 = contentHash("hello world");
  const h3 = contentHash("hello there");
  expect(h1).toBe(h2);
  expect(h1).not.toBe(h3);
  expect(Number.isNaN(Number(h1))).toBe(false);
});

test("newId produces prefixed, unique identifiers", () => {
  const a = newId("incident");
  const b = newId("incident");
  expect(a.startsWith("inc_")).toBe(true);
  expect(a).not.toBe(b);
  expect(ids.experiment().startsWith("exp_")).toBe(true);
});
