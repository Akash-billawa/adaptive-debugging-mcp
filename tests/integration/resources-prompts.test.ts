import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tempDbPath, openStore, closeStore } from "./helpers.ts";
import { buildCatalog } from "../../src/server/catalog.ts";
import { handleMessage } from "../../src/server/protocol.ts";

const paths: string[] = [];
function ctx() {
  const p = tempDbPath();
  paths.push(p);
  const store = openStore(p);
  const catalog = buildCatalog({ store, dbPath: p, log: () => {} });
  return { store, catalog, cleanup: () => closeStore(store) };
}
afterAll(() => {
  for (const p of paths) for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s, { force: true }); } catch {} }
});

test("protocol initialize: advertises tools, resources, and prompts capabilities", async () => {
  const { catalog, cleanup } = ctx();
  const res = await handleMessage(catalog, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });

  expect(res?.result).toBeDefined();
  const caps = (res?.result as any).capabilities;
  expect(caps.tools).toBeDefined();
  expect(caps.resources).toBeDefined();
  expect(caps.prompts).toBeDefined();
  cleanup();
});

test("resources: list and read incident summary, tree, evidence, and project recent", async () => {
  const { store, catalog, cleanup } = ctx();

  const { incident: inc } = store.createIncident({
    project: { display_name: "ResourceApp" },
    title: "Crash on JSON parse",
    initial_symptom: "Unexpected token in JSON at position 0",
    acceptance_criteria: "Returns 400 Bad Request on invalid JSON",
    actor: "agent",
  });

  const hyp = store.createHypothesis({
    incident_id: inc.incident_id,
    statement: "Payload content-type is json but body is form-urlencoded",
    rationale: "Headers show application/json",
    actor: "agent",
  });

  const { experiment: exp } = store.createExperiment({
    incident_id: inc.incident_id,
    node_kind: "experiment",
    title: "Validate content-type header parser",
    proposed_change: "Inspect req.headers['content-type']",
    expected_observation: "Header is correctly inspected",
    hypothesis_id: hyp.hypothesis_id,
    risk_level: "low",
    actor: "agent",
  });

  store.recordEvidence({
    project_id: inc.project_id,
    incident_id: inc.incident_id,
    experiment_id: exp.experiment_id,
    evidence_type: "log",
    content: "Content-Type: application/x-www-form-urlencoded",
    capture_source: "agent",
  });

  // 1. resources/list
  const listMsg = await handleMessage(catalog, { jsonrpc: "2.0", id: 2, method: "resources/list" });
  const resources = (listMsg?.result as any).resources;
  expect(Array.isArray(resources)).toBe(true);
  expect(resources.some((r: any) => r.uri.includes("debug://incident/{incident_id}/summary"))).toBe(true);
  expect(resources.some((r: any) => r.uri === `debug://incident/${inc.incident_id}/summary`)).toBe(true);

  // 2. resources/read - summary
  const readSummary = await handleMessage(catalog, {
    jsonrpc: "2.0",
    id: 3,
    method: "resources/read",
    params: { uri: `debug://incident/${inc.incident_id}/summary` },
  });
  expect(readSummary?.result).toBeDefined();
  const summaryPayload = JSON.parse((readSummary?.result as any).contents[0].text);
  expect(summaryPayload.incident.title).toBe("Crash on JSON parse");
  expect(summaryPayload.hypotheses_count).toBe(1);
  expect(summaryPayload.experiments_count).toBe(1);

  // 3. resources/read - tree
  const readTree = await handleMessage(catalog, {
    jsonrpc: "2.0",
    id: 4,
    method: "resources/read",
    params: { uri: `debug://incident/${inc.incident_id}/tree` },
  });
  const treePayload = JSON.parse((readTree?.result as any).contents[0].text);
  expect(treePayload.incident_id).toBe(inc.incident_id);
  expect(Array.isArray(treePayload.tree)).toBe(true);

  // 4. resources/read - evidence
  const readEv = await handleMessage(catalog, {
    jsonrpc: "2.0",
    id: 5,
    method: "resources/read",
    params: { uri: `debug://attempt/${exp.experiment_id}/evidence` },
  });
  const evPayload = JSON.parse((readEv?.result as any).contents[0].text);
  expect(evPayload.experiment.experiment_id).toBe(exp.experiment_id);
  expect(evPayload.evidence_count).toBe(1);

  // 5. resources/read - project recent
  const readRecent = await handleMessage(catalog, {
    jsonrpc: "2.0",
    id: 6,
    method: "resources/read",
    params: { uri: `debug://project/${inc.project_id}/recent` },
  });
  const recentPayload = JSON.parse((readRecent?.result as any).contents[0].text);
  expect(recentPayload.project_id).toBe(inc.project_id);
  expect(recentPayload.total_recent).toBeGreaterThanOrEqual(1);

  // 6. resources/read - error cases
  const badScheme = await handleMessage(catalog, {
    jsonrpc: "2.0",
    id: 7,
    method: "resources/read",
    params: { uri: "http://example.com" },
  });
  expect(badScheme?.error).toBeDefined();

  const missingInc = await handleMessage(catalog, {
    jsonrpc: "2.0",
    id: 8,
    method: "resources/read",
    params: { uri: "debug://incident/nonexistent/summary" },
  });
  expect(missingInc?.error).toBeDefined();

  cleanup();
});

test("prompts: list and get canonical debugging prompts", async () => {
  const { store, catalog, cleanup } = ctx();

  const { incident: inc } = store.createIncident({
    project: { display_name: "PromptApp" },
    title: "Database deadlock on concurrent writes",
    initial_symptom: "Deadlock detected lock wait timeout",
    actor: "agent",
  });

  const { experiment: exp } = store.createExperiment({
    incident_id: inc.incident_id,
    node_kind: "experiment",
    title: "Order batch operations by user_id",
    proposed_change: "Sort array before calling updateMany",
    expected_observation: "No deadlock in concurrent test",
    risk_level: "low",
    actor: "agent",
  });

  // 1. prompts/list
  const listMsg = await handleMessage(catalog, { jsonrpc: "2.0", id: 10, method: "prompts/list" });
  const prompts = (listMsg?.result as any).prompts;
  expect(Array.isArray(prompts)).toBe(true);
  expect(prompts.length).toBe(5);
  expect(prompts.some((p: any) => p.name === "debug_investigate_failure")).toBe(true);
  expect(prompts.some((p: any) => p.name === "debug_resume_investigation")).toBe(true);
  expect(prompts.some((p: any) => p.name === "debug_review_failures")).toBe(true);
  expect(prompts.some((p: any) => p.name === "debug_prepare_variant")).toBe(true);
  expect(prompts.some((p: any) => p.name === "debug_verify_fix")).toBe(true);

  // 2. prompts/get - debug_investigate_failure
  const p1 = await handleMessage(catalog, {
    jsonrpc: "2.0",
    id: 11,
    method: "prompts/get",
    params: { name: "debug_investigate_failure", arguments: { incident_id: inc.incident_id } },
  });
  const res1 = p1?.result as any;
  expect(res1.messages[0].content.text).toContain("Check Memory First");
  expect(res1.messages[0].content.text).toContain(inc.incident_id);

  // 3. prompts/get - debug_prepare_variant
  const p2 = await handleMessage(catalog, {
    jsonrpc: "2.0",
    id: 12,
    method: "prompts/get",
    params: {
      name: "debug_prepare_variant",
      arguments: { incident_id: inc.incident_id, parent_experiment_id: exp.experiment_id },
    },
  });
  const res2 = p2?.result as any;
  expect(res2.messages[0].content.text).toContain("reason_for_difference");

  // 4. prompts/get - debug_verify_fix
  const p3 = await handleMessage(catalog, {
    jsonrpc: "2.0",
    id: 13,
    method: "prompts/get",
    params: {
      name: "debug_verify_fix",
      arguments: { incident_id: inc.incident_id, experiment_id: exp.experiment_id },
    },
  });
  const res3 = p3?.result as any;
  expect(res3.messages[0].content.text).toContain("debug_validation_record");

  // 5. prompts/get - unknown prompt returns error
  const p4 = await handleMessage(catalog, {
    jsonrpc: "2.0",
    id: 14,
    method: "prompts/get",
    params: { name: "debug_unknown_prompt", arguments: { incident_id: inc.incident_id } },
  });
  expect(p4?.error).toBeDefined();

  cleanup();
});
