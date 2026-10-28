import { test, expect } from "bun:test";
import { openStore, closeStore } from "./helpers.ts";
import { buildCatalog } from "../../src/server/catalog.ts";

function setup() {
  const store = openStore(":memory:");
  const catalog = buildCatalog({ store, dbPath: ":memory:", log: () => {} });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await catalog.call(name, args);
    return res.structuredContent as any;
  };
  return { store, call };
}

test("intake redaction: case start redacts secrets in title, symptom, and environment", async () => {
  const { store, call } = setup();
  const dummyStripeKey = ["sk", "live", "51HabcdefghijklmnopqrstuvXYZ"].join("_");

  const res = await call("debug_case_start", {
    project: { display_name: "SecApp" },
    title: "Crash on connection to postgres://admin:S3cr3tP4ss@db.internal:5432/app",
    initial_symptom: "Failed connecting with password=hunter2hunter2 and api_key='abcd1234efgh5678'",
    environment: {
      tool_versions: {
        DB_PASSWORD: "hunter2hunter2",
        STRIPE_SECRET_KEY: dummyStripeKey,
      },
    },
  });

  const inc = store.getIncidentOrFail(res.incident_id);
  expect(inc.title).not.toContain("S3cr3tP4ss");
  expect(inc.title).toContain("[REDACTED:credentials]");

  expect(inc.initial_symptom).not.toContain("hunter2hunter2");
  expect(inc.initial_symptom).not.toContain("abcd1234efgh5678");

  // Read environment from DB
  const envRow = store.db.query("SELECT * FROM environments WHERE project_id = ?").get(inc.project_id) as any;
  if (envRow && envRow.tool_versions) {
    expect(envRow.tool_versions).not.toContain("hunter2hunter2");
    expect(envRow.tool_versions).not.toContain(dummyStripeKey);
  }

  closeStore(store);
});

test("intake redaction: hypotheses and attempts redact secrets before storage", async () => {
  const { store, call } = setup();

  const inc = (await call("debug_case_start", {
    project: { display_name: "SecApp" },
    title: "App error",
    initial_symptom: "Fails to run",
  })).incident_id;

  const hyp = await call("debug_hypothesis_manage", {
    incident_id: inc,
    op: "create_hypothesis",
    statement: "Server fails when token=zzzz9999yyyy8888 is passed in Authorization: Bearer abc123def456ghi789",
    rationale: "Found in logs: password='my pass phrase 42'",
  });

  const hypDb = store.listHypotheses(inc)[0];
  expect(hypDb.statement).not.toContain("zzzz9999yyyy8888");
  expect(hypDb.statement).not.toContain("abc123def456ghi789");
  expect(hypDb.rationale).not.toContain("my pass phrase 42");

  const exp = await call("debug_attempt_create", {
    incident_id: inc,
    node_kind: "experiment",
    hypothesis_id: hyp.hypothesis_id,
    title: "Try fixing with SLACK_BOT_TOKEN=abcd1234efgh5678",
    proposed_change: "Set MY_API_KEY=abcd1234efgh5678",
    expected_observation: "Service starts with redis://:Sup3rS3cretPW@cache:6379/0",
  });

  const expDb = store.getExperiment(exp.experiment_id)!;
  expect(expDb.title).not.toContain("abcd1234efgh5678");
  expect(expDb.proposed_change).not.toContain("abcd1234efgh5678");
  expect(expDb.expected_observation).not.toContain("Sup3rS3cretPW");

  closeStore(store);
});

test("intake redaction: evidence content is redacted by Store with redaction_status preserved", async () => {
  const { store, call } = setup();

  const inc = (await call("debug_case_start", {
    project: { display_name: "SecApp" },
    title: "App error",
    initial_symptom: "Fails to run",
  })).incident_id;

  const exp = (await call("debug_attempt_create", {
    incident_id: inc,
    node_kind: "experiment",
    title: "Test fix",
    expected_observation: "Runs",
  })).experiment_id;

  const evRes = await call("debug_evidence_record", {
    project_id: "prj_sec",
    incident_id: inc,
    experiment_id: exp,
    evidence_type: "stdout",
    content: "Connecting with redis://:Sup3rS3cretPW@cache:6379/0 and Bearer abc123def456ghi789jkl012",
    interpretation: "Notice password=hunter2hunter2 was logged",
    capture_source: "agent",
  });

  expect(evRes.redaction_status).toBe("redacted");
  expect(evRes.warnings).toContain("secrets_redacted_before_storage");

  const evContent = store.getEvidenceContent(evRes.evidence_id);
  expect(evContent?.content).not.toContain("Sup3rS3cretPW");
  expect(evContent?.content).not.toContain("abc123def456ghi789jkl012");
  expect(evContent?.content).toContain("[REDACTED:credentials]");

  const evMeta = store.listEvidence({ incident_id: inc })[0];
  expect(evMeta.redaction_status).toBe("redacted");
  expect(evMeta.interpretation).not.toContain("hunter2hunter2");

  closeStore(store);
});
