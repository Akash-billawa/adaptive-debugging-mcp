import { describe, test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tempDbPath, openStore, closeStore } from "./helpers.ts";
import { buildCatalog } from "../../src/server/catalog.ts";
import { handleMessage } from "../../src/server/protocol.ts";
import { buildFtsQuery, searchHistory } from "../../src/retrieval/search.ts";
import { indexIncidentEmbedding, syncAllEmbeddings, searchSemantic } from "../../src/retrieval/semantic.ts";
import { readResourceHandler } from "../../src/server/resources.ts";
import { getPromptHandler } from "../../src/server/prompts.ts";

const paths: string[] = [];
function ctx() {
  const p = tempDbPath();
  paths.push(p);
  const store = openStore(p);
  const catalog = buildCatalog({ store, dbPath: p, log: () => {} });
  return { store, catalog, p, cleanup: () => closeStore(store) };
}

afterAll(() => {
  for (const p of paths) {
    for (const s of ["", "-wal", "-shm"]) {
      try {
        rmSync(p + s, { force: true });
      } catch {}
    }
  }
});

describe("Issue 6: Isolation and API Correctness", () => {
  test("findRelatedIncidents does not leak incidents across projects", () => {
    const { store, cleanup } = ctx();

    // Create Incident in Project A
    const { incident: incA } = store.createIncident({
      project: { project_id: "proj_A", display_name: "Project A" },
      title: "Connection timeout to redis",
      initial_symptom: "ETIMEDOUT redis.internal:6379",
      fingerprints: [{ fingerprint_type: "normalized_message", fingerprint_value: "redis_timeout_sig" }],
      actor: "agent",
    });

    // Check related incidents for a new incident in Project B with the same fingerprint
    const relatedB = store.findRelatedIncidents(
      { project_id: "proj_B", display_name: "Project B" },
      [{ fingerprint_value: "redis_timeout_sig" }],
      "ETIMEDOUT redis.internal:6379",
    );
    expect(relatedB.length).toBe(0);

    // But searching for Project A returns it
    const relatedA = store.findRelatedIncidents(
      { project_id: "proj_A", display_name: "Project A" },
      [{ fingerprint_value: "redis_timeout_sig" }],
      "ETIMEDOUT redis.internal:6379",
    );
    expect(relatedA.length).toBe(1);
    expect(relatedA[0].incident_id).toBe(incA.incident_id);

    cleanup();
  });

  test("environment queries are scoped to incident project when experiment_id is null", async () => {
    const { store, catalog, cleanup } = ctx();

    // Project A incident
    const { incident: incA } = store.createIncident({
      project: { project_id: "proj_A", display_name: "Project A" },
      title: "Project A bug",
      initial_symptom: "Null pointer in A",
      actor: "agent",
    });

    // Project B incident
    const { incident: incB } = store.createIncident({
      project: { project_id: "proj_B", display_name: "Project B" },
      title: "Project B bug",
      initial_symptom: "Null pointer in B",
      actor: "agent",
    });

    // Insert an unattached environment snapshot for Project B
    store.db.query(
      `INSERT INTO environments (environment_id, project_id, experiment_id, os_name, runtime_versions, dependency_versions, capture_method, captured_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'agent', datetime('now'))`
    ).run("env_proj_B", "proj_B", "Linux-B", JSON.stringify({ node: "18.0.0" }), JSON.stringify({ lodash: "4.17.21" }));

    // Reading Project A's case environment must NOT return Project B's environment
    const readA = await catalog.call("debug_case_read", {
      incident_id: incA.incident_id,
      sections: ["environment"],
    });
    const envsA = (readA.structuredContent.environment as any[]);
    expect(envsA.some((e) => e.project_id === "proj_B")).toBe(false);

    // Reading Project B's case environment DOES return Project B's environment
    const readB = await catalog.call("debug_case_read", {
      incident_id: incB.incident_id,
      sections: ["environment"],
    });
    const envsB = (readB.structuredContent.environment as any[]);
    expect(envsB.some((e) => e.environment_id === "env_proj_B")).toBe(true);

    cleanup();
  });

  test("debug_history_search isolates by project_id and supports active_incident_id exclusion", async () => {
    const { store, catalog, cleanup } = ctx();

    // Project A incident & experiment
    const { incident: incA } = store.createIncident({
      project: { project_id: "proj_A", display_name: "Project A" },
      title: "SyntaxError in parse-config.ts",
      initial_symptom: "Failed to parse JSON config in parse-config.ts",
      fingerprints: [{ fingerprint_type: "normalized_message", fingerprint_value: "fp_parse_err" }],
      actor: "agent",
    });

    const { experiment: expA } = store.createExperiment({
      incident_id: incA.incident_id,
      node_kind: "experiment",
      title: "Inspect parse-config.ts parser",
      proposed_change: "Fix parser syntax",
      expected_observation: "clean parse",
      risk_level: "low",
      actor: "agent",
    });

    // Project B incident
    const { incident: incB } = store.createIncident({
      project: { project_id: "proj_B", display_name: "Project B" },
      title: "SyntaxError in parse-config.ts in Project B",
      initial_symptom: "Failed to parse JSON config in parse-config.ts in Project B",
      fingerprints: [{ fingerprint_type: "normalized_message", fingerprint_value: "fp_parse_err" }],
      actor: "agent",
    });

    // Sync semantic embeddings
    syncAllEmbeddings(store);

    // Search scoped to Project A must not return Project B
    const searchA = await catalog.call("debug_history_search", {
      query: "parse-config.ts JSON",
      fingerprints: ["fp_parse_err"],
      project_id: "proj_A",
      include_cross_project: false,
    });
    const resultsA = searchA.structuredContent.results as any[];
    expect(resultsA.some((r) => r.incident_id === incA.incident_id)).toBe(true);
    expect(resultsA.some((r) => r.incident_id === incB.incident_id)).toBe(false);

    // When active_incident_id is provided, it is excluded from history
    const searchExcl = await catalog.call("debug_history_search", {
      query: "parse-config.ts",
      project_id: "proj_A",
      active_incident_id: incA.incident_id,
    });
    const resultsExcl = searchExcl.structuredContent.results as any[];
    expect(resultsExcl.some((r) => r.incident_id === incA.incident_id)).toBe(false);

    cleanup();
  });

  test("buildFtsQuery tokenizes hyphenated and dotted terms properly", () => {
    const fts = buildFtsQuery("parse-config.ts");
    expect(fts).toBeDefined();
    // Must contain parse, config, ts as OR tokens
    expect(fts).toContain('"parse"');
    expect(fts).toContain('"config"');
    expect(fts).toContain('"ts"');
  });

  test("recordEvidence fills missing incident_id from experiment_id", () => {
    const { store, cleanup } = ctx();

    const { incident: inc } = store.createIncident({
      project: { display_name: "EvidenceApp" },
      title: "Evidence test",
      initial_symptom: "Fail",
      actor: "agent",
    });

    const { experiment: exp } = store.createExperiment({
      incident_id: inc.incident_id,
      node_kind: "experiment",
      title: "Run diagnostic",
      proposed_change: "test",
      expected_observation: "pass",
      risk_level: "low",
      actor: "agent",
    });

    // Record evidence WITHOUT incident_id, providing only experiment_id
    const { evidence } = store.recordEvidence({
      project_id: inc.project_id,
      experiment_id: exp.experiment_id,
      evidence_type: "log",
      content: "Diagnostic line 1: secret=my_secret_token",
      capture_source: "agent",
    });

    expect(evidence.incident_id).toBe(inc.incident_id);

    // Stored row in DB also has incident_id
    const fetched = store.getEvidence(evidence.evidence_id);
    expect(fetched?.incident_id).toBe(inc.incident_id);

    cleanup();
  });

  test("evidence read path: debug_case_read and resources return stored redacted content", async () => {
    const { store, catalog, cleanup } = ctx();

    const { incident: inc } = store.createIncident({
      project: { display_name: "ReadEvidenceApp" },
      title: "Read evidence test",
      initial_symptom: "Crash",
      actor: "agent",
    });

    const { experiment: exp } = store.createExperiment({
      incident_id: inc.incident_id,
      node_kind: "experiment",
      title: "Run diagnostic test",
      proposed_change: "Inspect stdout",
      expected_observation: "stdout captured",
      risk_level: "low",
      actor: "agent",
    });

    const { evidence } = store.recordEvidence({
      project_id: inc.project_id,
      incident_id: inc.incident_id,
      experiment_id: exp.experiment_id,
      evidence_type: "stdout",
      content: "Starting server on port 8080 with token=supersecretkey1234",
      capture_source: "agent",
    });

    // 1. debug_case_read with include_evidence_content: true
    const caseRead = await catalog.call("debug_case_read", {
      incident_id: inc.incident_id,
      include_evidence_content: true,
    });
    const attempts = caseRead.structuredContent.attempts as any[];
    expect(attempts.length).toBe(1);
    expect(attempts[0].evidence.length).toBe(1);
    expect(attempts[0].evidence[0].content).toContain("[REDACTED:");
    expect(attempts[0].evidence[0].content).not.toContain("supersecretkey1234");

    // 2. Resource debug://evidence/{id}/content
    const evContentRes = readResourceHandler(store, `debug://evidence/${evidence.evidence_id}/content`);
    expect(evContentRes.contents.length).toBe(1);
    expect(evContentRes.contents[0].text).toContain("[REDACTED:");
    expect(evContentRes.contents[0].text).not.toContain("supersecretkey1234");

    // 3. Resource debug://attempt/{id}/evidence
    const attEvRes = readResourceHandler(store, `debug://attempt/${exp.experiment_id}/evidence`);
    const attEvPayload = JSON.parse(attEvRes.contents[0].text);
    expect(attEvPayload.evidence.length).toBe(1);
    expect(attEvPayload.evidence[0].content).toContain("[REDACTED:");

    cleanup();
  });

  test("buildTree depth truncation stops recursing when depth >= maxDepth", () => {
    const { store, cleanup } = ctx();

    const { incident: inc } = store.createIncident({
      project: { display_name: "TreeApp" },
      title: "Tree depth test",
      initial_symptom: "Recursive error",
      actor: "agent",
    });

    // Root (depth 0)
    const { experiment: exp0 } = store.createExperiment({
      incident_id: inc.incident_id,
      node_kind: "experiment",
      title: "Exp 0",
      proposed_change: "c0",
      expected_observation: "o0",
      risk_level: "low",
      actor: "agent",
    });

    // Child (depth 1)
    const { experiment: exp1 } = store.createExperiment({
      incident_id: inc.incident_id,
      node_kind: "variant",
      parent_experiment_id: exp0.experiment_id,
      reason_for_difference: "Refinement 1",
      title: "Exp 1",
      proposed_change: "c1",
      expected_observation: "o1",
      risk_level: "low",
      actor: "agent",
    });

    // Grandchild (depth 2)
    const { experiment: exp2 } = store.createExperiment({
      incident_id: inc.incident_id,
      node_kind: "variant",
      parent_experiment_id: exp1.experiment_id,
      reason_for_difference: "Refinement 2",
      title: "Exp 2",
      proposed_change: "c2",
      expected_observation: "o2",
      risk_level: "low",
      actor: "agent",
    });

    // Great-grandchild (depth 3)
    store.createExperiment({
      incident_id: inc.incident_id,
      node_kind: "variant",
      parent_experiment_id: exp2.experiment_id,
      reason_for_difference: "Refinement 3",
      title: "Exp 3",
      proposed_change: "c3",
      expected_observation: "o3",
      risk_level: "low",
      actor: "agent",
    });

    // Request with maxDepth = 1
    const tree1 = store.buildTree(inc.incident_id, null, 1);
    expect(tree1.nodes.length).toBe(1);
    const rootNode = tree1.nodes[0];
    expect(rootNode.depth).toBe(0);
    expect(rootNode.children.length).toBe(1);

    const childNode = rootNode.children[0];
    expect(childNode.depth).toBe(1);
    // Depth 1 is at maxDepth, so it must not descend further
    expect(childNode.children.length).toBe(0);
    expect(childNode.truncated).toBe(true);

    cleanup();
  });

  test("debug://incident/{id}/tree throws notFound on missing incident", () => {
    const { store, cleanup } = ctx();
    expect(() => readResourceHandler(store, "debug://incident/nonexistent_123/tree")).toThrow("not found");
    cleanup();
  });

  test("debug_case_read defaults include hypotheses and attempts, and rejects non-numeric max_attempts", async () => {
    const { store, catalog, cleanup } = ctx();

    const { incident: inc } = store.createIncident({
      project: { display_name: "CaseApp" },
      title: "Case read test",
      initial_symptom: "Err",
      actor: "agent",
    });

    store.createHypothesis({
      incident_id: inc.incident_id,
      statement: "Hypothesis A",
      rationale: "Rationale A",
      actor: "agent",
    });

    // Default call with no sections specified
    const defRead = await catalog.call("debug_case_read", {
      incident_id: inc.incident_id,
    });
    expect(defRead.structuredContent.hypotheses).toBeDefined();
    expect(Array.isArray(defRead.structuredContent.hypotheses)).toBe(true);
    expect(defRead.structuredContent.attempts).toBeDefined();

    // Calling with max_attempts: "ten" must throw a validation error
    await expect(
      catalog.call("debug_case_read", {
        incident_id: inc.incident_id,
        max_attempts: "ten" as any,
      })
    ).rejects.toThrow("max_attempts must be a valid positive integer");

    cleanup();
  });

  test("researchTools maps environment columns correctly from database", async () => {
    const { store, catalog, cleanup } = ctx();

    const { incident: inc } = store.createIncident({
      project: { display_name: "ResearchApp" },
      title: "Research evaluator test",
      initial_symptom: "Version mismatch error",
      actor: "agent",
    });

    // Insert environment snapshot with runtime_versions and dependency_versions
    store.db.query(
      `INSERT INTO environments (environment_id, project_id, experiment_id, os_name, os_version, runtime_versions, dependency_versions, capture_method, captured_at)
       VALUES (?, ?, NULL, 'linux', '5.15', ?, ?, 'agent', datetime('now'))`
    ).run(
      "env_eval",
      inc.project_id,
      JSON.stringify({ bun: "1.1.0" }),
      JSON.stringify({ express: "4.18.2" }),
    );

    // Call debug_research_plan
    const plan = await catalog.call("debug_research_plan", {
      incident_id: inc.incident_id,
    });
    expect(plan.structuredContent.ok).toBe(true);

    // Call debug_research_evaluate
    const evalRes = await catalog.call("debug_research_evaluate", {
      incident_id: inc.incident_id,
      sources: [
        {
          source_title: "Express Release Notes",
          source_type: "official_docs",
          excerpt: "Express 4.18.2 supports latest runtime features",
          claimed_version: "4.18.2",
          claims: ["express is compatible"],
        },
      ],
    });
    expect(evalRes.structuredContent.ok).toBe(true);
    const evals = evalRes.structuredContent.evaluations as any[];
    expect(evals.length).toBe(1);
    expect(evals[0].version_match_score).toBeGreaterThan(0.7);

    cleanup();
  });

  test("protocol returns -32601 on unknown tool and supports resources/templates/list", async () => {
    const { catalog, cleanup } = ctx();

    // Unknown tool call must return JSON-RPC error -32601
    const unknownRes = await handleMessage(catalog, {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "non_existent_tool_xyz", arguments: {} },
    });
    expect(unknownRes?.error).toBeDefined();
    expect(unknownRes?.error?.code).toBe(-32601);
    expect(unknownRes?.result).toBeUndefined();

    // resources/templates/list returns resourceTemplates
    const tmplRes = await handleMessage(catalog, {
      jsonrpc: "2.0",
      id: 100,
      method: "resources/templates/list",
    });
    expect(tmplRes?.result).toBeDefined();
    const templates = (tmplRes?.result as any).resourceTemplates;
    expect(Array.isArray(templates)).toBe(true);
    expect(templates.some((t: any) => t.uriTemplate === "debug://evidence/{evidence_id}/content")).toBe(true);

    cleanup();
  });

  test("prompts wrap untrusted data in <untrusted_data> tags and verify_fix instructs correct parameters", () => {
    const { store, cleanup } = ctx();

    const { incident: inc } = store.createIncident({
      project: { display_name: "PromptApp" },
      title: "Prompt test",
      initial_symptom: "Malicious <script>alert(1)</script> symptom",
      acceptance_criteria: "Pass test",
      actor: "agent",
    });

    const { experiment: exp } = store.createExperiment({
      incident_id: inc.incident_id,
      node_kind: "experiment",
      title: "Fix bug",
      proposed_change: "fix",
      expected_observation: "fixed",
      risk_level: "low",
      actor: "agent",
    });

    // debug_investigate_failure
    const invPrompt = getPromptHandler(store, "debug_investigate_failure", {
      incident_id: inc.incident_id,
    });
    const invText = invPrompt.messages[0].content.text;
    expect(invText).toContain("<untrusted_data>");
    expect(invText).toContain("</untrusted_data>");

    // debug_verify_fix
    const verifyPrompt = getPromptHandler(store, "debug_verify_fix", {
      incident_id: inc.incident_id,
      experiment_id: exp.experiment_id,
    });
    const verText = verifyPrompt.messages[0].content.text;
    expect(verText).toContain("execution_result: 'pass'");
    expect(verText).toContain("criteria_results");
    expect(verText).not.toContain("resolution_decision: 'verified' if all pass");

    cleanup();
  });
});
