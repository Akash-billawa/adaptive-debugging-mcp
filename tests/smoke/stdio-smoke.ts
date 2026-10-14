/**
 * End-to-end stdio smoke test: launches the MCP server as a child process,
 * performs the initialize handshake, and exercises a full investigation
 * lifecycle (case_start -> hypothesis -> attempt create -> evidence -> outcome ->
 * validation -> resolve, plus search/tree/health/export) AND the budget
 * enforcement contract over the REAL protocol (catalog rethrows McpError; the
 * stdio protocol layer converts it to an isError response).
 *
 * Hermetic: the server runs against a FRESH temp database created for this run
 * and deleted afterwards. A previous version ran against a reused smoke.db and
 * inherited stale state across runs, producing a false failure — isolation now
 * lives inside the test, not in the invocation.
 */
import { spawn } from "bun";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const ROOT = join(import.meta.dir, "..", "..");
const SERVER = join(ROOT, "src", "server", "index.ts");
const DB = join(tmpdir(), `admcp-stdio-smoke-${Date.now()}-${randomBytes(4).toString("hex")}.db`);
console.log("smoke db:", DB);

const proc = spawn({
  cmd: ["bun", "run", SERVER, "--db", DB],
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, ADAPTIVE_DEBUG_DB_PATH: DB },
});

const stdout = proc.stdout.getReader();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let buffer = "";

function rpcWrite(msg: Record<string, unknown>) {
  proc.stdin.write(encoder.encode(JSON.stringify(msg) + "\n"));
  proc.stdin.flush();
}

async function readResponse(id: number | string | null): Promise<any> {
  const deadline = Date.now() + 10000;
  for (;;) {
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const obj = JSON.parse(line);
      if (obj.id === id || (id === null && obj.id === null)) return obj;
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for id ${id}`);
    const { value, done } = await stdout.read();
    if (done) throw new Error("server closed stdout");
    buffer += decoder.decode(value, { stream: true });
  }
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, extra ?? ""); }
}

async function callTool(name: string, args: Record<string, unknown>, id: number): Promise<any> {
  rpcWrite({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const res = await readResponse(id);
  return res.result;
}

try {
  // 1) initialize
  rpcWrite({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  const init = await readResponse(1);
  check("initialize returns serverInfo", init.result?.serverInfo?.name === "adaptive-debugging-mcp", init.result);
  rpcWrite({ jsonrpc: "2.0", method: "notifications/initialized" });

  // 2) tools/list complete with all tools present
  rpcWrite({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = await readResponse(2);
  const names = list.result?.tools?.map((t: any) => t.name) ?? [];
  const required = [
    "debug_case_start","debug_history_search","debug_case_read","debug_attempt_create",
    "debug_evidence_record","debug_attempt_update","debug_tree_read","debug_validation_record","debug_case_status_update",
    "debug_next_experiment_prepare","debug_budget_manage",
  ];
  for (const r of required) check(`tool listed: ${r}`, names.includes(r));
  check("17 tools registered", names.length === 17, names.length);

  // 3) health (fresh db: zero records)
  const health0 = await callTool("debug_server_health", {}, 3);
  check("health ok on fresh db", health0.structuredContent?.ok === true && health0.structuredContent?.checks?.incidents === 0, health0.structuredContent?.checks);

  // 4) start incident
  const start = await callTool("debug_case_start", {
    project: { display_name: "SmokeApp", repository_uri: "file:///smoke" },
    title: "parser crashes on malformed payload",
    initial_symptom: "TypeError: Cannot read properties of undefined (reading 'id')",
    error_text: "TypeError: Cannot read properties of undefined (reading 'id') at parse (C:\\app\\src\\p.js:42:11)",
    reproduction_status: "reproduced",
    acceptance_criteria: "feeding the malformed payload returns a 400 validation error, no crash",
    actor: "agent",
  }, 4);
  const incidentId = start.structuredContent?.incident_id;
  check("case_start returns incident_id", typeof incidentId === "string" && incidentId.startsWith("inc_"), start.structuredContent);

  // 5) hypothesis
  const hyp = await callTool("debug_hypothesis_manage", { op: "create_hypothesis", incident_id: incidentId, statement: "Request body is undefined because body-parser is not mounted", rationale: "500 shows parse() on undefined", actor: "agent" }, 5);
  const hypId = hyp.structuredContent?.hypothesis_id;
  check("hypothesis created", typeof hypId === "string");

  // 5b) REGRESSION (hypothesis contract): the attested alternative names work over
  // the real protocol, are disclosed, and the canonical name is preferred.
  // Agents have been observed sending `hypothesis` / `testable_claim` instead of
  // the canonical `statement`; the handler accepts them for compatibility.
  const hypAlias1 = await callTool("debug_hypothesis_manage", { op: "create_hypothesis", incident_id: incidentId, testable_claim: "Malformed payloads reach the handler because validation runs after routing", rationale: "crash happens inside the handler, past the router", actor: "agent" }, 100);
  check("alias testable_claim creates a hypothesis", hypAlias1.structuredContent?.ok === true && typeof hypAlias1.structuredContent?.hypothesis_id === "string", hypAlias1.structuredContent ?? hypAlias1);
  check("alias testable_claim is disclosed", hypAlias1.structuredContent?.statement_normalized_from === "testable_claim", hypAlias1.structuredContent);
  const hypAlias2 = await callTool("debug_hypothesis_manage", { op: "create_hypothesis", incident_id: incidentId, hypothesis: "The 500 is returned by the error middleware, not the handler", rationale: "response shape matches the error formatter", actor: "agent" }, 101);
  check("alias hypothesis creates a hypothesis", hypAlias2.structuredContent?.ok === true, hypAlias2.structuredContent ?? hypAlias2);
  check("alias hypothesis is disclosed", hypAlias2.structuredContent?.statement_normalized_from === "hypothesis", hypAlias2.structuredContent);

  // Canonical wins when both are present.
  const hypBoth = await callTool("debug_hypothesis_manage", { op: "create_hypothesis", incident_id: incidentId, statement: "CANONICAL wins over aliases", hypothesis: "ALIAS must not be stored", testable_claim: "ALIAS2 must not be stored", rationale: "precedence check", actor: "agent" }, 102);
  check("canonical statement wins over aliases", hypBoth.structuredContent?.ok === true && hypBoth.structuredContent?.statement_normalized_from === undefined, hypBoth.structuredContent);

  // Missing statement (and any alias) is a self-describing validation error.
  const hypMissing = await callTool("debug_hypothesis_manage", { op: "create_hypothesis", incident_id: incidentId, rationale: "no claim supplied", actor: "agent" }, 103);
  const missingMsg = String(hypMissing.structuredContent?.error?.message ?? "");
  check("missing statement is a self-describing validation error",
    hypMissing.isError === true &&
    hypMissing.structuredContent?.error?.category === "VALIDATION_ERROR" &&
    missingMsg.includes("statement") && missingMsg.includes("testable_claim"),
    hypMissing.structuredContent ?? hypMissing);

  // The testable claim text is preserved verbatim as the stored statement.
  const readBack = await callTool("debug_case_read", { incident_id: incidentId, sections: ["hypotheses"] }, 104);
  const storedHyps = readBack.structuredContent?.hypotheses ?? [];
  const storedAlias1 = storedHyps.find((h: any) => h.hypothesis_id === hypAlias1.structuredContent?.hypothesis_id);
  const storedBoth = storedHyps.find((h: any) => h.hypothesis_id === hypBoth.structuredContent?.hypothesis_id);
  check("alias-supplied testable claim preserved verbatim", storedAlias1?.statement === "Malformed payloads reach the handler because validation runs after routing", storedAlias1);
  check("canonical statement preserved verbatim", storedBoth?.statement === "CANONICAL wins over aliases", storedBoth);


  // 6) strategy root "A", experiment "A1", variant "A1A"
  const strat = await callTool("debug_attempt_create", { incident_id: incidentId, node_kind: "strategy", title: "Ensure request body is parsed before handlers", hypothesis_id: hypId, expected_observation: "req.body is defined in handlers", risk_level: "low", actor: "agent" }, 6);
  const stratId = strat.structuredContent?.experiment_id;
  check("strategy root label A", strat.structuredContent?.display_label === "A", strat.structuredContent);

  const a1 = await callTool("debug_attempt_create", { incident_id: incidentId, node_kind: "experiment", title: "Add body-parser middleware", parent_experiment_id: stratId, hypothesis_id: hypId, proposed_change: "app.use(express.json())", expected_observation: "req.body defined", risk_level: "low", actor: "agent" }, 7);
  check("attempt A1 label", a1.structuredContent?.display_label === "A1", a1.structuredContent);
  const a1id = a1.structuredContent?.experiment_id;

  const a1a = await callTool("debug_attempt_create", { incident_id: incidentId, node_kind: "variant", title: "Mount body-parser before routes", parent_experiment_id: a1id, hypothesis_id: hypId, reason_for_difference: "middleware order matters; moved before route handlers", proposed_change: "reorder middleware", expected_observation: "req.body defined", risk_level: "low", actor: "agent" }, 8);
  check("variant A1A label", a1a.structuredContent?.display_label === "A1A", a1a.structuredContent);

  // 7) evidence + failed outcome
  await callTool("debug_evidence_record", { project_id: start.structuredContent?.project_id, incident_id: incidentId, experiment_id: a1id, evidence_type: "stderr", content: "TypeError: reading 'id' line 42. token=sk-SECRETvalue1234567890abcd", interpretation: "still crashes; body not parsed", capture_source: "agent" }, 9);
  const upd = await callTool("debug_attempt_update", { attempt_id: a1id, execution_status: "completed", outcome_status: "failed", actual_observation: "still crashes at parse", failure_reason: "req.body undefined", actor: "agent" }, 10);
  check("attempt updated failed", upd.structuredContent?.outcome_status === "failed", upd.structuredContent);

  // 8) guard: verified outcome is rejected on attempt_update
  const badVerified = await callTool("debug_attempt_update", { attempt_id: a1id, outcome_status: "verified", actual_observation: "x", actor: "agent" }, 11);
  check("cannot set verified via attempt_update", badVerified.isError === true);

  // 9) validation resolves A1A path
  const valRes = await callTool("debug_validation_record", {
    incident_id: incidentId, experiment_id: a1a.structuredContent.experiment_id,
    validation_plan: "malformed payload returns 400, no crash",
    criteria_results: [{ criteria: "malformed payload returns 400", status: "passed" }, { criteria: "no crash", status: "passed" }],
    execution_result: "passed", reproduced_before: true, verified_by: "agent",
  }, 12);
  check("validation verified", valRes.structuredContent?.verified === true && valRes.structuredContent?.decision === "verified", valRes.structuredContent);

  // 10) tree read
  const tree = await callTool("debug_tree_read", { incident_id: incidentId }, 13);
  check("tree has strategy+experiment+variant", (tree.structuredContent?.total_nodes ?? 0) >= 3 && Array.isArray(tree.structuredContent?.tree));

  // 11) resolve incident (valid transition path open -> investigating -> resolved)
  await callTool("debug_case_status_update", { incident_id: incidentId, status: "investigating", rationale: "starting review of parsed-body fix", actor: "agent" }, 14);
  const resolve = await callTool("debug_case_status_update", { incident_id: incidentId, status: "resolved", verification_id: valRes.structuredContent.validation_id, rationale: "original failure condition passes with recorded validation", actor: "user" }, 15);
  check("incident resolved", resolve.structuredContent?.status === "resolved", resolve.structuredContent);

  // 12) history search later "session"
  const search = await callTool("debug_history_search", { query: "parser crashes reading id undefined", project_id: start.structuredContent?.project_id, limit: 5 }, 16);
  check("history_search finds incident", search.structuredContent?.results?.some((r: any) => r.incident_id === incidentId), search.structuredContent);

  // 13) case read distinguishes observation vs interpretation
  const read = await callTool("debug_case_read", { incident_id: incidentId, sections: ["attempts", "timeline", "validations"] }, 17);
  check("case_read returns attempts with observed+interpretation", Array.isArray(read.structuredContent?.attempts));

  // 14) export
  const exp = await callTool("debug_data_export", { incident_id: incidentId }, 18);
  check("export returns incident tree", exp.structuredContent?.incident?.incident_id === incidentId && Array.isArray(exp.structuredContent?.experiments));

  // 15) budget enforcement surfaces as a machine-readable MCP error over the REAL protocol
  // (catalog rethrows McpError; the stdio protocol layer converts it to an isError response)
  const setBudget = await callTool("debug_budget_manage", { op: "set_incident_override", incident_id: incidentId, config: { max_total_experiments: 2 }, rationale: "smoke: tight budget", actor: "agent" }, 19);
  check("budget override accepted", setBudget.structuredContent?.ok === true, setBudget.structuredContent);
  const healthBefore = await callTool("debug_server_health", {}, 20);
  const expBefore = healthBefore.structuredContent?.checks?.experiments;
  const overBudget = await callTool("debug_attempt_create", { incident_id: incidentId, node_kind: "experiment", title: "over budget", expected_observation: "blocked", risk_level: "low", actor: "agent" }, 21);
  check("budget violation -> isError LIMIT_EXCEEDED over protocol",
    overBudget.isError === true &&
    overBudget.structuredContent?.error?.category === "LIMIT_EXCEEDED" &&
    overBudget.structuredContent?.error?.details?.limit_name === "max_total_experiments",
    overBudget.structuredContent ?? overBudget);
  const healthAfter = await callTool("debug_server_health", {}, 22);
  check("no partially created experiment after budget violation",
    healthAfter.structuredContent?.checks?.experiments === expBefore,
    { before: expBefore, after: healthAfter.structuredContent?.checks?.experiments });

  // 16) next-action decision over the real protocol (resolved incident)
  const next = await callTool("debug_next_experiment_prepare", { incident_id: incidentId }, 23);
  check("next-action reports resolved state", next.structuredContent?.exhaustion?.state === "resolved" &&
    typeof next.structuredContent?.budget?.config?.max_total_experiments === "number", next.structuredContent?.exhaustion);

  console.log(`\nSMOKE RESULT: ${passed} passed, ${failed} failed`);
} catch (e) {
  console.error("smoke error:", e);
  failed++;
} finally {
  try { proc.kill(); } catch { /* ignore */ }
}

proc.exited.then(() => {
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s, { force: true }); } catch { /* ignore */ } }
  process.exit(failed > 0 ? 1 : 0);
});
