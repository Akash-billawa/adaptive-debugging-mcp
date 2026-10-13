# Adaptive Debugging MCP — Build Checklist

Implementation checklist derived from the planning documents. Status: **MVP implemented and green** (all tests + stdio smoke pass). "Later" items remain future work by design.

## A. Scaffolding (MVP) — DONE
- [x] Project dir `adaptive-debugging-mcp/` with `package.json`, `tsconfig.json`, `.gitignore`
- [x] Directory layout separating `server`, `memory`, `retrieval`, `security` (+ `plugin/`, `.opencode/`)
- [x] Runtime: Bun + `bun:sqlite` (FTS5, WAL verified)

## B. Foundation (MVP) — DONE
- [x] Controlled vocabularies — `src/vocab.ts`
- [x] Shared TS types — `src/types.ts`
- [x] Secret redaction before persistence + indexing — `src/security/redaction.ts`
- [x] Stable ID + display-label generation (A/A1/A1A depth-parity scheme) — `src/memory/ids.ts`
- [x] SQLite connection + WAL + schema-version runner, `:memory:` support — `src/memory/db.ts`
- [x] Schema DDL + FTS5 indexes (v1) and `plugin_observations` (v2) — `src/memory/schema.ts`
- [x] Ordered transactional migrations + integrity checks — `src/memory/db.ts`

## C. Domain modules (MVP) — DONE
- [x] Incident manager (create/reopen/close, dedup suggestions, transition validation, project scope)
- [x] Environment snapshot capture
- [x] Hypothesis + strategy managers
- [x] Experiment-tree manager (arbitrary nesting, parent links, cross-incident rejection, labels, depth guard)
- [x] Evidence manager (types, redaction status, 64KB bound, inline content table, provenance, interpretation separation)
- [x] Research-reference manager
- [x] Validation/verification manager (acceptance criteria; sole path to `verified`)
- [x] Append-only timeline/audit events
- [x] Relationship/link records + plugin observations (v2) with association

## D. Retrieval (MVP) — DONE
- [x] Error fingerprint normalization (paths/UUID/time/IP/hex/LOC; raw retained) — `src/retrieval/fingerprint.ts`
- [x] Full-text + fingerprint + filter search with relevance explanations — `src/retrieval/search.ts`
- [x] Duplicate/equivalent-attempt detection (exact action + token overlap) — `src/retrieval/duplicates.ts`
- [x] Explicit "no match" vs "history unavailable" states

## E. MCP server + core tools (MVP) — DONE
- [x] Stdio JSON-RPC transport (newline-delimited; logs to stderr) — `src/server/transport.ts`
- [x] MCP protocol handlers (initialize/notifications/ping/tools list/call; empty resources+prompts) — `src/server/protocol.ts`
- [x] Tool registry + input validation + structured error categories — `src/server/catalog.ts`, `src/errors.ts`
- [x] `debug_case_start`
- [x] `debug_history_search`
- [x] `debug_case_read`
- [x] `debug_attempt_create`
- [x] `debug_evidence_record`
- [x] `debug_attempt_update` (blocks direct `verified`)
- [x] `debug_tree_read`
- [x] `debug_validation_record`
- [x] `debug_case_status_update` (requires qualifying validation for `resolved`)
- [x] Supporting: `debug_hypothesis_manage`, `debug_research_record`, `debug_timeline_read`, `debug_case_link`, `debug_data_export`, `debug_server_health`

## F. OpenCode integration assets (MVP) — DONE
- [x] `opencode.jsonc.example` registering the local MCP server
- [x] Dedicated debugging agent — `.opencode/agents/deep-debug.md`
- [x] Project instructions — `.opencode/AGENTS.md`
- [x] Reusable skill — `.opencode/skills/deep-debug/SKILL.md`
- [x] Slash commands — `.opencode/commands/` (`deep-debug`, `resume-debug`, `debug-status`, `debug-review`)

## G. Observation plugin (Next) — DONE (v1, observation-only)
- [x] `plugin/index.ts` OpenCode plugin: tool.execute.before/after + session.error hooks
- [x] Redaction before persistence; bounded summaries
- [x] Idempotent event keys (dedup on retries)
- [x] Honest capture states; no invented data; no cross-boundary claims; non-blocking writes

## H. Tests (MVP) — DONE
- [x] Unit: redaction (8), fingerprint (6), ids/labels (5)
- [x] Integration: restart durability, nested A/A1/A1A/A1B with preserved failures, command-success ≠ verified, validation gating, secret redaction end-to-end (incl. search non-leak), project isolation, duplicate detection, invalid parents/transitions
- [x] Catalog: tool registry, unknown tool, idempotency, evidence-or-justification rule, enum validation
- [x] Search quality fixtures: multi-project corpus, exact-duplicate vs similar-but-distinct errors, verified history
- [x] Stdio smoke: full MCP lifecycle over real transport (24 checks)
- [x] `bun test` green: 32 tests / 96 assertions; `bunx tsc --noEmit` clean

## I. Docs + packaging (MVP) — DONE
- [x] `README.md` (setup, registration, tools, safety, boundaries)
- [x] Smoke: launch server over stdio and exercise a full incident lifecycle

## J. OpenCode v2 migration & session integration (2026-10-12) — DONE
- [x] Registration migrated to the v2 schema (`mcp.servers.<name>` via `opencode mcp add`; v1-shaped `mcp.<name>` + `enabled` is not read by v2.0.27)
- [x] Agent frontmatter rewritten for v2 (permissions as ordered rule lists; legacy `temperature`/`permission` fields are forbidden)
- [x] Plugin ported to the v2 API (`Plugin.define` + `ctx.tool.hook` + `ctx.event.subscribe`) with a documented dual v1+v2 export; `@opencode/plugin@2.0.27` installed
- [x] Global install: MCP server (`opencode mcp add --global`), plugin (global `plugins` array), agent/skill/4 commands under `~/.config/opencode/`
- [x] Workspace-root project duplicates removed (single source of truth; sub-repo keeps packaging templates)
- [x] First two REAL incidents recorded through the live MCP tools (import provenance): I1 resolved with 3 verified validations; I2 reopened after controlled experiments and resolved with a root-caused explanation
- [x] "No MCP servers configured" first-run behavior root-caused (fresh folders A/D/E, fast vs delayed retests): OpenCode time-gated per-directory initialization affecting ALL servers — external behavior; workaround documented in README troubleshooting
- [ ] Observation-plugin in-host activation — pending verification (after `opencode service restart` or next OpenCode restart, run `bun run obs-check`; expect observations > 0)

## K. Adaptive upgrade — exhaustion, refinement, budgets, evaluation (v0.2) — DONE
- [x] Gap analysis verified against actual code (existing vocab/tree/duplicate/validation reused; no second server, no rewrite, additive-only changes)
- [x] Exhaustion-detection engine (`src/engine/exhaustion.ts`): 6 computed states integrated with the incident lifecycle; pending/interrupted/inconclusive never exhausted; tracked-space-only wording; new hypotheses/evidence reopen
- [x] Candidate ranking + refinement (`src/engine/ranking.ts`): explainable heuristic factors, no recency bias, separate re-run bucket for interrupted/inconclusive, dismissed-family cautions, duplicate-proximity penalty
- [x] Configurable budgets (`src/engine/budgets.ts` + schema v3 `budgets` table): family/variant/total/depth/duration limits (defaults 3/3/25/3/off), risk-ceiling advisory, near-limit warnings, project defaults + per-incident overrides with audit-trail recording, budget snapshot on case_start, resumable handoffs; cost limits recorded but NOT enforced (no reliable accounting)
- [x] Hard enforcement at `debug_attempt_create` via the existing `LIMIT_EXCEEDED` error category — verified over the REAL protocol in the hermetic stdio smoke, including no-partial-persistence on violation
- [x] Structured next-action decision: `debug_next_experiment_prepare` (one recommendation with evidence/uncertainty/expected-observation/what-would-change; durable handoff on budget stop) + `debug_budget_manage` — 17 tools total, all additive
- [x] Historical integrity: schema v3 migration additive; v2→v3 migration + restart-persistence tests green; no status semantics changed; append-only history preserved
- [x] Evaluation harness: 14 deterministic scenarios + metrics + baseline comparison (`tests/evaluation/scenarios.test.ts`) — covers the decision layer; live LLM-in-the-loop quality documented as requiring interactive sessions (honest limitation)
- [x] Full verification: 73 tests / 223 assertions, `tsc --noEmit` clean, hermetic stdio smoke 31/31 (protocol-level budget error + relative no-partial-create checks)

## Later (deliberately deferred — see Development Roadmap)

- [ ] Semantic/embedding retrieval (only after baseline evaluation)
- [ ] `debug_candidate_compare` standalone matrix tool (its purpose is currently served by duplicate warnings + the ranking in `debug_next_experiment_prepare`; add only if a workflow need emerges)
- [ ] Research connectors beyond manual `debug_research_record`
- [ ] Backup/restore + retention CLI; cross-project retrieval UI
- [ ] AI model routing (explicitly deferred per the upgrade constraints)
- [ ] Live LLM-in-the-loop evaluation sessions (the harness covers the deterministic decision layer)
