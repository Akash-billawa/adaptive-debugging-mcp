import { test, expect } from "bun:test";
import { redact, redactWithStatus, redactDeep } from "../../src/security/redaction.ts";

const BODY = "1234567890abcdefghijklmnopqrstuvwxyz";
function j(...parts: string[]) { return parts.join(""); }

const CASES = [
  { name: "redis URL with empty user", text: "redis://:Sup3rS3cretPW@cache:6379/0", secret: "Sup3rS3cretPW" },
  { name: "DATABASE_URL env", text: "DATABASE_URL=postgres://admin:S3cr3tP4ss@db.internal:5432/app", secret: "S3cr3tP4ss" },
  { name: "JSON password", text: '{"password": "hunter2hunter2"}', secret: "hunter2hunter2" },
  { name: "JSON api_key", text: '{"api_key": "abcd1234efgh5678"}', secret: "abcd1234efgh5678" },
  { name: "JSON token", text: '{"token": "zzzz9999yyyy8888"}', secret: "zzzz9999yyyy8888" },
  { name: "JSON Authorization header", text: '{"Authorization": "Bearer abc123def456ghi789"}', secret: "abc123def456ghi789" },
  { name: "Authorization: Bearer", text: "Authorization: Bearer abc123def456ghi789", secret: "abc123def456ghi789" },
  { name: "Authorization: Basic", text: "Authorization: Basic dXNlcjpwYXNzd29yZA==", secret: "dXNlcjpwYXNzd29yZA==" },
  { name: "Authorization with no scheme", text: "Authorization: abc123def456ghi789", secret: "abc123def456ghi789" },
  { name: "bare long Bearer token", text: "retrying with Bearer abc123def456ghi789jkl012", secret: "abc123def456ghi789jkl012" },
  { name: "Cookie header", text: "Cookie: sessionid=abc123def456; csrftoken=xyz987uvw", secret: "abc123def456" },
  { name: "DB_PASSWORD env", text: "DB_PASSWORD=hunter2hunter2", secret: "hunter2hunter2" },
  { name: "prefixed token env", text: "SLACK_BOT_TOKEN=abcd1234efgh5678", secret: "abcd1234efgh5678" },
  { name: "prefixed api key env", text: "MY_API_KEY=abcd1234efgh5678", secret: "abcd1234efgh5678" },
  { name: "camelCase JSON key", text: '{"clientSecret": "abcd1234efgh5678"}', secret: "abcd1234efgh5678" },
  { name: "Stripe secret key env", text: `STRIPE_SECRET_KEY=${j("sk", "_live_")}51HabcdefghijklmnopqrstuvXYZ`, secret: "51HabcdefghijklmnopqrstuvXYZ" },
  { name: "npm _authToken", text: `//registry.npmjs.org/:_authToken=${j("npm", "_")}${BODY}`, secret: BODY },
  { name: "GitLab token", text: `${j("glpat", "-")}AbCdEfGhIjKlMnOpQrSt`, secret: "AbCdEfGhIjKlMnOpQrSt" },
  { name: "GitHub token", text: j("ghp", "_") + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8", secret: "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8" },
  { name: "AWS secret access key", text: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
  { name: "AWS access key id", text: "AKIAIOSFODNN7EXAMPLE", secret: "AKIAIOSFODNN7EXAMPLE" },
  { name: "complete private key", text: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxxSECRETBODYxxxx\n-----END RSA PRIVATE KEY-----", secret: "SECRETBODY" },
  { name: "truncated private key (no END marker)", text: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxxSECRETBODYxxxx\nyyyyyyyyyyyyyyyy", secret: "SECRETBODY" },
  { name: "OpenSSH private key", text: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAASECRETBODY", secret: "SECRETBODY" },
  { name: "?access_token= in a URL", text: "GET https://api.example.com/v1?access_token=abcdef1234567890&x=1", secret: "abcdef1234567890" },
  { name: "curl -u user:pass", text: "curl -u admin:S3cr3tP4ss https://example.com", secret: "S3cr3tP4ss" },
  { name: "quoted value with spaces (:)", text: 'password: "my pass phrase 42"', secret: "pass phrase" },
  { name: "quoted value with spaces (=)", text: "password='my pass phrase 42' next", secret: "pass phrase" },
  { name: "JWT", text: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", secret: "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" },
  { name: "Slack token", text: j("xoxb", "-1234567890-abcdefghij"), secret: "abcdefghij" },
  { name: "Slack webhook", text: "POST https://hooks.slack.com/services/T0000000/B0000000/abcdefghijKLMNOPqrstuvwx", secret: "abcdefghijKLMNOPqrstuvwx" },
];

test("no credential format in the coverage battery survives redaction", () => {
  const leaks = CASES.filter((c) => redact(c.text).text.includes(c.secret)).map((c) => c.name);
  expect(leaks).toEqual([]);
});

test("redaction is idempotent and still reports the redaction", () => {
  for (const c of CASES) {
    const once = redact(c.text);
    expect(once.status).toBe("redacted");
    expect(redact(once.text).text).toBe(once.text);
  }
});

test("ordinary debugging text is left alone", () => {
  const benign = [
    "max_tokens=4096 and tokens: 12",
    "Authorization header missing from request",
    "Bearer authentication failed",
    "token expired at 12:30",
    "password must be at least 8 characters",
    "see http://localhost:4873/@scope/pkg for the package",
    "ssh://git@github.com/org/repo.git",
    "PATH=/usr/bin:/bin NODE_ENV=production",
    "task-runner-with-a-very-long-name-here",
    "cookie banner is shown on first visit",
    "GET /api/v1/users?page=2&limit=50 200 OK",
    "Error: ENOENT: no such file or directory, open '/app/config.json'",
    "commit 3f2c1ab9 fixed the secret rotation job",
  ];
  for (const b of benign) expect(redact(b).text).toBe(b);
});

test("rule kinds name the credential that was found", () => {
  expect(redact(`key ${j("sk", "-ant-api03-")}${BODY}`).kinds).toContain("anthropic_key");
  expect(redact("postgres://u:pw12345678@h/db").kinds).toContain("url_credentials");
  expect(redact("Authorization: Basic dXNlcjpwYXNzd29yZA==").kinds).toContain("authorization_header");
});

test("redactDeep redacts nested strings, secret-named keys and reports the changed paths", () => {
  const input = {
    title: "login fails",
    symptom: "connect postgres://u:pw12345678@h/db failed",
    environment: { env: { DB_PASSWORD: "hunter2hunter2", NODE_ENV: "test", apiKey: "abcd1234efgh5678" } },
    hypotheses: ["fine", "password=hunter2hunter2"],
    count: 3,
    flag: true,
    nothing: null,
  };
  const { value, fields } = redactDeep(input);
  const text = JSON.stringify(value);
  expect(text).not.toContain("pw12345678");
  expect(text).not.toContain("hunter2hunter2");
  expect(text).not.toContain("abcd1234efgh5678");
  expect(value.title).toBe("login fails");
  expect(value.environment.env.NODE_ENV).toBe("test");
  expect(value.count).toBe(3);
  expect(value.flag).toBe(true);
  expect(value.nothing).toBeNull();
  expect(fields.sort()).toEqual(["environment.env.DB_PASSWORD", "environment.env.apiKey", "hypotheses[1]", "symptom"].sort());
  expect(input.environment.env.DB_PASSWORD).toBe("hunter2hunter2"); // input is not mutated
});

test("redactDeep can leave a field to the caller", () => {
  const { value, fields } = redactDeep({ content: "password=hunter2hunter2", note: "token=abcd1234efgh" }, { skip: (p) => p === "content" });
  expect(value.content).toBe("password=hunter2hunter2");
  expect(value.note).not.toContain("abcd1234efgh");
  expect(fields).toEqual(["note"]);
});

test("redaction flags and removes common secrets", () => {
  const input = [
    "AWS=AKIAIOSFODNN7EXAMPLE",
    "github=" + ["ghp", "1234567890abcdefghijklmnopqrstuvwxyz"].join("_"),
    "openai=" + ["sk", "abcdefghijklmnopqrstuvwxyz0123456789ABCD"].join("-"),
    "slack=" + ["xoxb", "1234567890", "abcdefghijklmnop"].join("-"),
    "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w",
    "google=" + ["AIzaSyA", "1234567890abcdefghijklmnopqrstuv"].join(""),
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
  expect(r.kinds).toContain("authorization_header");
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
