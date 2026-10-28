---
name: deep-debug
description: Structured adaptive debugging procedure for difficult bugs — search history first, hypothesize, inspect source code, implement a minimal fix when authorized, run tests, record evidence, and verify the original failure before declaring resolution. Use when a bug resists a first fix, recurs across sessions, or multiple approaches have failed.
---

# Deep Debugging Procedure

A repeatable investigation, diagnosis, and fix procedure backed by the `adaptive-debug-memory` MCP server. Load this skill when a bug needs systematic, multi-attempt investigation.

## Principles

- Evidence before confidence: observed output, AI interpretation, and hypothesis are three separate things.
- Every attempt teaches something; failed attempts are the most valuable records.
- Novelty with a reason: never re-run an equivalent experiment without stating what changed.
- Verified resolution only: green commands are not fixes until acceptance criteria pass.
- Host tool boundaries: use native host tools for reading, editing, and executing; never assume MCP memory tools modify files or run commands.

## Multi-session safety

Other sessions may be working the same incident through shared memory. At meaningful boundaries — before planning a new batch of writes, before recording a validation, and before resolving — re-check the case:

1. Call `debug_next_experiment_prepare` for authoritative current state and recommended next action.
2. If ownership, status, or recent activity is ambiguous, `debug_case_read` the case or `debug_timeline_read` recent events — another session may have already done the work.
3. Never create an experiment, evidence, or validation that already exists — reuse existing records instead of duplicating.
4. A resolved case is never silently mutated: a recurrence is reopened (`debug_case_status_update`) or a new incident is linked.
5. Re-check immediately before recording validation or resolving — concurrent sessions may have changed the state since you last checked.
6. Verified outcomes are immutable to ordinary updates: a regressed fix is downgraded by recording a failing re-validation, never by editing the outcome field.

---

## Step 0 — Decide the scope

- Trivial bug with an obvious cause? Fix it directly; no records needed.
- Anything else: run this procedure.

## Step 1 — Search persistent debugging history & characterize the failure

1. Capture:
   - Verbatim error text and where it occurred.
   - Reproduction steps/status (`reproduced` / `intermittent` / `not_reproduced`).
   - Expected vs actual behavior.
   - Relevant environment (OS, runtime, dependency versions, git state) — no secrets.
2. Call `debug_case_start`:
   - Pass `error_text` so fingerprints are derived automatically.
   - Pass explicit `acceptance_criteria` that must hold for resolution.
   - Review `related_case_suggestions`: resume an existing incident if matched (`debug_case_read`).
3. Call `debug_history_search` with error text and project ID to inspect prior attempts and lessons. If search reports `history_unavailable`, note it explicitly and proceed.

## Step 2 — Investigate the error & formulate competing hypotheses

Create 2+ competing explanations with `debug_hypothesis_manage` (`op: "create_hypothesis"`), each with a testable claim in the canonical `statement` field plus a `rationale`. Competing hypotheses prevent confirmation bias and force discriminating experiments.

## Step 3 — Prepare a justified experiment with an appropriate budget

1. Call `debug_next_experiment_prepare` to evaluate budget limits, check exhaustion state, and retrieve ranked refinement candidates.
2. For each candidate experiment, know:
   - Which hypothesis it tests and what observation would support/reject it.
   - What materially differs from prior attempts (mandatory for variants: `reason_for_difference`).
   - Risk, rough cost, and preconditions.
3. Record with `debug_attempt_create`. Read `duplicate_warnings`: if `exact_action` or `high_overlap` is flagged, redesign or record justification in `reason_for_difference`.

## Step 4 — Inspect and understand the affected source code

Before modifying any file:
1. Use native host file-reading tools (`view_file`, read tools) to examine the failing source code and call chains.
2. Inspect the relevant unit/integration tests to understand the expected behavior and reproduction setup.
3. Confirm that the proposed change targets the root cause identified in the leading hypothesis.

## Step 5 — Implement a minimal fix when editing tools are available and authorized

1. **If editing tools are available (`replace_file_content`, `write_to_file`, `edit`) and the user has authorized the fix:**
   - Make the minimal surgical change required to test the hypothesis and resolve the bug.
   - Avoid unrelated refactoring or collateral edits.
2. **If editing tools are absent (e.g. running in a read-only or diagnostic-only subagent context):**
   - Accurately report missing host capabilities (e.g., "Active agent lacks file-editing tools").
   - Provide the complete diagnosis, verified hypothesis, proposed minimal diff/patch, and exact test instructions to the user.
   - Record the attempt outcome with `debug_attempt_update` as `blocked` with `failure_reason` noting missing host capabilities.

## Step 6 — Run relevant tests and inspect actual results

1. **If execution tools are available (`run_command`, shell):**
   - Execute the targeted test suite or reproduction command.
   - Inspect stdout, stderr, exit code, and test report.
2. **If execution tools are absent:**
   - Accurately report missing terminal execution capabilities.
   - Instruct the user to run the test command manually and provide the observed output.

## Step 7 — Record evidence, validation, and final outcome

1. Attach raw outputs with `debug_evidence_record` (`content` = raw output; `interpretation` = your analysis, kept separate).
2. Update the attempt with `debug_attempt_update`: honest `execution_status` (`completed` / `failed_to_execute` / `interrupted`) and `outcome_status` (`candidate`, `failed`, `partial`, `inconclusive`, `blocked`).
3. If the test failed:
   - Provide `failure_reason`. The incident remains open.
   - Adapt hypotheses (`debug_hypothesis_manage` op `update_hypothesis_status`).
   - Return to Step 3 for a variant or alternative hypothesis.
4. If the test passed and the candidate appears to fix the bug:
   - Run the ORIGINAL reproduction/acceptance criteria check.
   - Record via `debug_validation_record` with per-criterion results and evidence IDs.
   - If decision is `verified`: update incident status to `investigating` (if still `open`), then to `resolved` with `debug_case_status_update` (passing `verification_id`).

## Step 8 — Recheck incident state across sessions

Before closing or performing significant write batches, call `debug_next_experiment_prepare` to confirm the case state has not been modified by another concurrent session.

---

## Quick reference

| Situation | Tool call |
|---|---|
| New failure under investigation | `debug_case_start` |
| Before proposing any fix | `debug_history_search` |
| Full context of a past/current case | `debug_case_read` |
| Formulate or update explanations | `debug_hypothesis_manage` |
| Check budget and plan next step | `debug_next_experiment_prepare` |
| Manage exploration budgets | `debug_budget_manage` |
| Plan an experiment/variant | `debug_attempt_create` |
| Save what actually happened | `debug_evidence_record` |
| Record outcome of an attempt | `debug_attempt_update` |
| See the branch tree / what's untested | `debug_tree_read` |
| Audit what happened when | `debug_timeline_read` |
| Check acceptance criteria | `debug_validation_record` |
| Close / reopen / block a case | `debug_case_status_update` |
| Save a consulted source | `debug_research_record` |
| Relate two records without merging | `debug_case_link` |
| Compare candidate proposals | `debug_candidate_compare` |
| Formulate research questions | `debug_research_plan` |
| Evaluate external research credibility | `debug_research_evaluate` |
| Inspect code snippets or manifests | `debug_codebase_analyze` |
| Sync dense semantic vector index | `debug_semantic_index` |
| Export incident tree or visual dashboard | `debug_data_export` |
| Memory server status | `debug_server_health` |
