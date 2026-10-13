import { test, expect } from "bun:test";
import { redact, redactWithStatus } from "../../src/security/redaction.ts";

test("redaction flags and removes common secrets", () => {
  const input = [
    "AWS=AKIAIOSFODNN7EXAMPLE",
    "github=ghp_1234567890abcdefghijklmnopqrstuvwxyz",
    "openai=sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    "slack=xoxb-1234567890-abcdefghijklmnop",
    "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w",
    "google=AIzaSyA1234567890abcdefghijklmnopqrstuv",
  ].join("\n");
  const r = redact(input);
  expect(r.status).toBe("redacted");
  for (const kind of ["aws_access_key_id", "github_token", "openai_key", "slack_token", "jwt", "google_api_key"]) {
    expect(r.kinds).toContain(kind);
  }
  expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect(r.text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  expect(r.text).not.toContain("AIzaSyA1234567890");
});

test("redaction handles key=value secrets and connection strings", () => {
  const input = "password=SuperSecret123 api_key: abcd1234efgh5678 Secret='topsecretvalue' AccountKey=QWxhZGRpbjpvcGVuIHNlc2FtZQ==;";
  const r = redact(input);
  expect(r.status).toBe("redacted");
  expect(r.text).not.toContain("SuperSecret123");
  expect(r.text).not.toContain("topsecretvalue");
  expect(r.text).not.toContain("QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
});

test("redaction removes private key blocks", () => {
  const input = "log: -----BEGIN RSA PRIVATE KEY-----\nMIIEabcPRIVATE\nmore\n-----END RSA PRIVATE KEY-----\nafter";
  const r = redact(input);
  expect(r.kinds).toContain("private_key_block");
  expect(r.text).not.toContain("MIIEabcPRIVATE");
  expect(r.text).toContain("[REDACTED:private_key_block]");
  expect(r.text).toContain("after");
});

test("redaction redacts Authorization Bearer tokens", () => {
  const r = redact("Authorization: Bearer eyJtokenvalue1234567890abcdef");
  expect(r.kinds).toContain("bearer_token");
  expect(r.text).not.toContain("eyJtokenvalue1234567890abcdef");
});

test("clean text is reported as no_secret_detected", () => {
  const r = redactWithStatus("normal build output with no credentials");
  expect(r.status).toBe("no_secret_detected");
  expect(r.kinds.length).toBe(0);
  expect(r.text).toBe("normal build output with no credentials");
});

test("empty input is safe", () => {
  const r = redactWithStatus("");
  expect(r.status).toBe("no_secret_detected");
});
