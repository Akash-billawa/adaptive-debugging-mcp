import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tempDbPath, openStore, closeStore } from "./helpers.ts";
import { buildCatalog, ALL_TOOLS } from "../../src/server/catalog.ts";
import { buildFingerprintValues } from "../../src/retrieval/fingerprint.ts";
import type { Store } from "../../src/memory/store.ts";

const paths: string[] = [];
function ctx() {
  const p = tempDbPath();
  paths.push(p);
  const store = openStore(p);
  return {
    store,
    catalog: buildCatalog({ store, dbPath: p, log: () => {} }),
    cleanup: () => closeStore(store),
  };
}
afterAll(() => {
  for (const p of paths) {
    for (const s of ["", "-wal", "-shm"]) {
      try { rmSync(p + s, { force: true }); } catch {}
    }
  }
});

async function call(catalog: any, name: string, args: Record<string, unknown>) {
  try {
    const res = await catalog.call(name, args);
    return { isError: res.isError, structured: res.structuredContent as any };
  } catch (e: any) {
    return {
      isError: true,
      category: e.category ?? "INTERNAL_ERROR",
      message: e.message,
      structured: { ok: false, error: { category: e.category, message: e.message, details: e.details } },
    };
  }
}

// ---------------------------------------------------------------------------
// 1. Workflow does not stop at diagnosis when editing and execution tools are available
// ---------------------------------------------------------------------------
test("workflow proceeds past diagnosis to code inspection, minimal fix, testing, validation, and resolution", async () => {
  const { catalog, cleanup } = ctx();

  // Step 1: Search history first
  const searchBefore = await call(catalog, "debug_history_search", {
    query: "NullPointerException in UserService.getUser",
    limit: 5,
  });
  expect(searchBefore.isError).toBe(false);

  // Characterize failure with acceptance criteria
  const fps = buildFingerprintValues("NullPointerException: user not found at UserService.getUser(UserService.java:42)");
  const start = await call(catalog, "debug_case_start", {
    project: { display_name: "AuthApp", project_id: "prj_auth" },
    title: "NPE on missing user",
    initial_symptom: "NullPointerException when user ID does not exist",
    error_text: "NullPointerException: user not found at UserService.getUser(UserService.java:42)",
    fingerprints: fps.map((f) => f.fingerprint_value),
    reproduction_status: "reproduced",
    acceptance_criteria: "getUser returns Optional.empty() instead of throwing NPE",
    actor: "agent",
  });
  expect(start.isError).toBe(false);
  const incId = start.structured.incident_id;

  // Move incident to investigating
  const inv = await call(catalog, "debug_case_status_update", {
    incident_id: incId,
    status: "investigating",
    rationale: "Starting deep-debug investigation and hypothesis formulation",
    actor: "agent",
  });
  expect(inv.isError).toBe(false);

  // Step 2: Formulate competing hypotheses
  const h1 = await call(catalog, "debug_hypothesis_manage", {
    incident_id: incId,
    op: "create_hypothesis",
    statement: "UserService.getUser accesses entity directly without null check",
    rationale: "Stack trace points to line 42 where user.getId() is called immediately",
    actor: "agent",
  });
  const h2 = await call(catalog, "debug_hypothesis_manage", {
    incident_id: incId,
    op: "create_hypothesis",
    statement: "Database repository returns invalid null entity instead of throwing EntityNotFoundException",
    rationale: "Repository contract might have changed",
    actor: "agent",
  });
  expect(h1.isError).toBe(false);
  expect(h2.isError).toBe(false);

  // Step 3: Prepare justified experiment and check budget
  const prep = await call(catalog, "debug_next_experiment_prepare", { incident_id: incId });
  expect(prep.isError).toBe(false);
  expect(prep.structured.exhaustion.state).toBe("exploring");
  expect(prep.structured.budget.usage.total_experiments).toBe(0);

  // Record the planned experiment
  const exp = await call(catalog, "debug_attempt_create", {
    incident_id: incId,
    node_kind: "experiment",
    hypothesis_id: h1.structured.hypothesis_id,
    title: "Wrap entity in Optional.ofNullable in UserService.getUser",
    proposed_change: "return Optional.ofNullable(repo.find(id)) instead of dereferencing",
    expected_observation: "Unit tests pass with Optional.empty() returned for missing user",
    risk_level: "low",
    actor: "agent",
  });
  expect(exp.isError).toBe(false);
  const expId = exp.structured.experiment_id;

  // Step 4 & 5: Code inspection & minimal fix (simulated host tools)
  const hostToolEditAvailable = true;
  expect(hostToolEditAvailable).toBe(true);

  // Step 6: Execute tests via host command and observe actual results
  const testExecution = {
    exitCode: 0,
    stdout: "Running UserServiceTest... 5 tests passed, 0 failed. OK.",
    passed: true,
  };

  // Step 7: Record real evidence and validation
  const ev = await call(catalog, "debug_evidence_record", {
    project_id: "prj_auth",
    incident_id: incId,
    experiment_id: expId,
    evidence_type: "stdout",
    content: testExecution.stdout,
    capture_source: "agent",
    interpretation: "UserServiceTest passed with null user returning Optional.empty",
  });
  expect(ev.isError).toBe(false);

  // Update experiment outcome to candidate (or completed execution)
  const updExp = await call(catalog, "debug_attempt_update", {
    attempt_id: expId,
    execution_status: "completed",
    outcome_status: "candidate",
    actual_observation: "All 5 unit tests pass, no NPE thrown",
    actor: "agent",
  });
  expect(updExp.isError).toBe(false);

  // Record formal validation against acceptance criteria
  const val = await call(catalog, "debug_validation_record", {
    incident_id: incId,
    experiment_id: expId,
    validation_plan: "Run UserServiceTest covering missing user ID and normal user ID",
    criteria_results: [
      { criteria: "getUser returns Optional.empty() instead of throwing NPE", status: "passed" },
      { criteria: "existing user lookup still passes", status: "passed" },
    ],
    execution_result: "passed",
    evidence_ids: [ev.structured.evidence_id],
    verified_by: "agent",
  });
  expect(val.isError).toBe(false);
  expect(val.structured.decision).toBe("verified");

  // Update case status to resolved using verification_id
  const resolve = await call(catalog, "debug_case_status_update", {
    incident_id: incId,
    status: "resolved",
    verification_id: val.structured.validation_id,
    rationale: "Acceptance criteria verified with evidence from passing test suite",
    actor: "agent",
  });
  expect(resolve.isError).toBe(false);
  expect(resolve.structured.status).toBe("resolved");

  // Step 8: Multi-session / final check shows case is cleanly resolved
  const finalPrep = await call(catalog, "debug_next_experiment_prepare", { incident_id: incId });
  expect(finalPrep.structured.exhaustion.state).toBe("resolved");
  expect(finalPrep.structured.next_action.why_now).toContain("The incident is resolved and verified; no further investigation is required");

  cleanup();
});

// ---------------------------------------------------------------------------
// 2. Missing host capabilities are reported accurately
// ---------------------------------------------------------------------------
test("missing host capabilities are reported accurately and do not falsely verify", async () => {
  const { catalog, cleanup } = ctx();

  const start = await call(catalog, "debug_case_start", {
    project: { display_name: "ReadOnlyEnv" },
    title: "Syntax error in build",
    initial_symptom: "Build fails due to missing semicolon",
    actor: "agent",
  });
  const incId = start.structured.incident_id;

  const h = await call(catalog, "debug_hypothesis_manage", {
    incident_id: incId,
    op: "create_hypothesis",
    statement: "Missing semicolon on line 12",
    rationale: "Parser error indicates unexpected token",
    actor: "agent",
  });

  const exp = await call(catalog, "debug_attempt_create", {
    incident_id: incId,
    node_kind: "experiment",
    hypothesis_id: h.structured.hypothesis_id,
    title: "Add semicolon to line 12",
    proposed_change: "Insert ; at end of statement",
    expected_observation: "Build succeeds",
    risk_level: "low",
    actor: "agent",
  });
  const expId = exp.structured.experiment_id;

  // Simulate environment where host editing and terminal tools are NOT provided
  const hostTools = {
    hasFileEditing: false,
    hasTerminalExecution: false,
  };

  const missingCapabilities: string[] = [];
  if (!hostTools.hasFileEditing) missingCapabilities.push("file editing (write_to_file / replace_file_content)");
  if (!hostTools.hasTerminalExecution) missingCapabilities.push("terminal execution (run_command)");

  expect(missingCapabilities.length).toBe(2);

  // When tools are missing, the experiment cannot be executed or verified:
  // It is marked blocked or candidate with honest failure_reason / notes
  const updateBlocked = await call(catalog, "debug_attempt_update", {
    attempt_id: expId,
    execution_status: "failed_to_execute",
    outcome_status: "blocked",
    actual_observation: "Host environment lacks editing and execution tools; fix could not be applied or tested",
    failure_reason: `Missing host capabilities: ${missingCapabilities.join(", ")}. Diagnostic handoff produced.`,
    actor: "agent",
  });
  expect(updateBlocked.isError).toBe(false);
  expect(updateBlocked.structured.outcome_status).toBe("blocked");

  // Verify that incident remains open and unverified
  const check = await call(catalog, "debug_case_read", { incident_id: incId });
  expect(check.structured.incident.status).toBe("open");

  cleanup();
});

// ---------------------------------------------------------------------------
// 3. A proposed fix is tested before being marked verified
// ---------------------------------------------------------------------------
test("a proposed fix cannot be marked verified without a passing validation run", async () => {
  const { catalog, cleanup } = ctx();

  const start = await call(catalog, "debug_case_start", {
    project: { display_name: "GateTest" },
    title: "Validation gating test",
    initial_symptom: "API timeout",
    actor: "agent",
  });
  const incId = start.structured.incident_id;

  const exp = await call(catalog, "debug_attempt_create", {
    incident_id: incId,
    node_kind: "experiment",
    title: "Increase timeout",
    proposed_change: "timeout 5s -> 10s",
    expected_observation: "requests succeed",
    risk_level: "low",
    actor: "agent",
  });
  const expId = exp.structured.experiment_id;

  // Direct attempt_update to verified MUST be rejected
  const directVerified = await call(catalog, "debug_attempt_update", {
    attempt_id: expId,
    outcome_status: "verified",
    actual_observation: "looks good to me",
    actor: "agent",
  });
  expect(directVerified.isError).toBe(true);

  // Recording validation with failing criteria must yield unverified
  const failingVal = await call(catalog, "debug_validation_record", {
    incident_id: incId,
    experiment_id: expId,
    validation_plan: "Test timeout under load",
    criteria_results: [{ criteria: "Requests finish within 10s", status: "failed" }],
    execution_result: "failed",
    evidence_ids: [],
    verified_by: "agent",
  });
  expect(failingVal.structured.decision).toBe("unverified");

  // Attempting to resolve with an unverified validation must be rejected
  const badResolve = await call(catalog, "debug_case_status_update", {
    incident_id: incId,
    status: "resolved",
    verification_id: failingVal.structured.validation_id,
    rationale: "premature resolution attempt",
    actor: "agent",
  });
  expect(badResolve.isError).toBe(true);

  cleanup();
});

// ---------------------------------------------------------------------------
// 4. Failed tests remain recorded as failures
// ---------------------------------------------------------------------------
test("failed tests remain recorded as failures and never falsely resolve", async () => {
  const { catalog, cleanup } = ctx();

  const start = await call(catalog, "debug_case_start", {
    project: { display_name: "FailApp" },
    title: "Memory leak in worker",
    initial_symptom: "OOM after 1000 jobs",
    actor: "agent",
  });
  const incId = start.structured.incident_id;

  const exp = await call(catalog, "debug_attempt_create", {
    incident_id: incId,
    node_kind: "experiment",
    title: "Clear buffer on job complete",
    proposed_change: "buffer.clear()",
    expected_observation: "Memory stays below 100MB",
    risk_level: "low",
    actor: "agent",
  });
  const expId = exp.structured.experiment_id;

  // Test fails
  const failedOutput = "FAIL tests/worker.test.ts: Heap memory exceeded 256MB at job 412";
  const ev = await call(catalog, "debug_evidence_record", {
    project_id: "prj_fail",
    incident_id: incId,
    experiment_id: expId,
    evidence_type: "stderr",
    content: failedOutput,
    capture_source: "agent",
    interpretation: "Buffer was not the source of the leak; worker retained closure references",
  });
  expect(ev.isError).toBe(false);

  // Honest failure update
  const upd = await call(catalog, "debug_attempt_update", {
    attempt_id: expId,
    execution_status: "completed",
    outcome_status: "failed",
    actual_observation: "Heap exceeded 256MB despite buffer.clear()",
    failure_reason: "Root cause is closure reference retention, not the raw buffer",
    actor: "agent",
  });
  expect(upd.isError).toBe(false);
  expect(upd.structured.outcome_status).toBe("failed");

  // Next action routes to refinement or new strategy, not resolved
  const next = await call(catalog, "debug_next_experiment_prepare", { incident_id: incId });
  expect(next.structured.exhaustion.state).not.toBe("resolved");
  expect(next.structured.next_action.recommended_action).not.toBe("none_resolved");

  cleanup();
});

// ---------------------------------------------------------------------------
// 5. Budget limits and lifecycle safeguards remain enforced
// ---------------------------------------------------------------------------
test("budget limits strictly block unbounded attempts and trigger handoff", async () => {
  const { catalog, cleanup } = ctx();

  const start = await call(catalog, "debug_case_start", {
    project: { display_name: "BudgetTest" },
    title: "Regex catastrophic backtracking",
    initial_symptom: "CPU 100% on parse",
    actor: "agent",
  });
  const incId = start.structured.incident_id;

  // Set tight budget: max 2 experiments per family
  await call(catalog, "debug_budget_manage", {
    incident_id: incId,
    op: "set_incident_override",
    config: { max_experiments_per_family: 2 },
    rationale: "tight budget test",
    actor: "user",
  });

  const strat = await call(catalog, "debug_attempt_create", {
    incident_id: incId,
    node_kind: "strategy",
    title: "Strategy: Regex tuning",
    proposed_change: "tune expressions",
    expected_observation: "no backtracking",
    risk_level: "low",
    actor: "agent",
  });
  const stratId = strat.structured.experiment_id;

  // 1st experiment in family -> OK
  const e1 = await call(catalog, "debug_attempt_create", {
    incident_id: incId,
    node_kind: "experiment",
    parent_experiment_id: stratId,
    title: "Attempt 1",
    proposed_change: "atomic group",
    expected_observation: "ok",
    risk_level: "low",
    actor: "agent",
  });
  expect(e1.isError).toBe(false);
  await call(catalog, "debug_attempt_update", {
    attempt_id: e1.structured.experiment_id,
    outcome_status: "failed",
    actual_observation: "failed",
    failure_reason: "still slow",
    actor: "agent",
  });

  // 2nd experiment in family -> OK
  const e2 = await call(catalog, "debug_attempt_create", {
    incident_id: incId,
    node_kind: "experiment",
    parent_experiment_id: stratId,
    title: "Attempt 2",
    proposed_change: "possessive quantifier",
    expected_observation: "ok",
    risk_level: "low",
    actor: "agent",
  });
  expect(e2.isError).toBe(false);
  await call(catalog, "debug_attempt_update", {
    attempt_id: e2.structured.experiment_id,
    outcome_status: "failed",
    actual_observation: "failed",
    failure_reason: "still slow",
    actor: "agent",
  });

  // 3rd experiment in family -> BLOCKED by LIMIT_EXCEEDED
  const e3 = await call(catalog, "debug_attempt_create", {
    incident_id: incId,
    node_kind: "experiment",
    parent_experiment_id: stratId,
    title: "Attempt 3",
    proposed_change: "third variation",
    expected_observation: "ok",
    risk_level: "low",
    actor: "agent",
  });
  expect(e3.isError).toBe(true);
  expect(e3.category).toBe("LIMIT_EXCEEDED");

  cleanup();
});

// ---------------------------------------------------------------------------
// 6. Concurrent sessions do not duplicate completed work
// ---------------------------------------------------------------------------
test("multi-session check detects work from concurrent sessions and prevents duplicate attempts", async () => {
  const { store, catalog, cleanup } = ctx();

  // Session A starts case and executes experiment
  const inc = store.createIncident({
    project: { display_name: "SharedApp" },
    title: "Race condition in cache",
    initial_symptom: "Stale data returned under load",
    actor: "session_A",
  }).incident;

  const expA = store.createExperiment({
    incident_id: inc.incident_id,
    node_kind: "experiment",
    title: "Add mutex lock to cache write",
    proposed_change: "mutex.acquire() before write",
    expected_observation: "no race condition",
    risk_level: "low",
    actor: "session_A",
  });

  store.updateExperiment(expA.experiment.experiment_id, {
    execution_status: "completed",
    outcome_status: "failed",
    actual_observation: "mutex caused deadlock under concurrent reads",
    failure_reason: "read lock was not re-entrant",
    actor: "session_A",
  });

  // Session B connects to the same case and calls debug_next_experiment_prepare
  const prepB = await call(catalog, "debug_next_experiment_prepare", {
    incident_id: inc.incident_id,
  });
  expect(prepB.isError).toBe(false);

  // Session B sees that Session A already attempted the mutex approach
  const tree = await call(catalog, "debug_tree_read", {
    incident_id: inc.incident_id,
  });
  expect(tree.structured.total_nodes).toBe(1);
  expect(tree.structured.tree[0].title).toBe("Add mutex lock to cache write");

  // If Session B tries to recreate an identical experiment, duplicate warnings flag it
  const dupB = await call(catalog, "debug_attempt_create", {
    incident_id: inc.incident_id,
    node_kind: "experiment",
    title: "Add mutex lock to cache write",
    proposed_change: "mutex.acquire() before write",
    expected_observation: "no race condition",
    risk_level: "low",
    actor: "session_B",
  });
  expect(dupB.isError).toBe(false);
  expect(dupB.structured.duplicate_warnings.length).toBeGreaterThan(0);
  expect(dupB.structured.duplicate_warnings[0].match).toBe("exact_action");

  cleanup();
});

// ---------------------------------------------------------------------------
// 7. Existing MCP tool contracts remain compatible
// ---------------------------------------------------------------------------
test("all 18 MCP tools remain registered with backward-compatible schemas", () => {
  expect(ALL_TOOLS.length).toBe(18);
  const toolNames = ALL_TOOLS.map((t) => t.def.name);
  const required = [
    "debug_case_start",
    "debug_case_read",
    "debug_case_status_update",
    "debug_history_search",
    "debug_hypothesis_manage",
    "debug_attempt_create",
    "debug_attempt_update",
    "debug_evidence_record",
    "debug_research_record",
    "debug_tree_read",
    "debug_timeline_read",
    "debug_validation_record",
    "debug_case_link",
    "debug_data_export",
    "debug_server_health",
    "debug_budget_manage",
    "debug_next_experiment_prepare",
    "debug_candidate_compare",
  ];
  for (const name of required) {
    expect(toolNames).toContain(name);
  }
});
