# Adaptive Debugging Intelligence MCP

A persistent debugging-memory and adaptive-investigation system for [OpenCode CLI](https://opencode.ai/). It helps an AI coding agent investigate difficult bugs **without repeating itself**: what was tried, what each failure actually established, which hypotheses remain open, and what a meaningfully different next experiment would be — with verification before anything is called "fixed".

> Built from the planning documents in the parent directory (`Adaptive_Debugging_MCP_*.md`). This repository is the MVP implementation: local MCP server, SQLite persistence with FTS5, nested experiment trees, evidence + redaction, verified resolution, tests, and OpenCode integration assets.

## What it does

- **Persistent investigation memory** — incidents, hypotheses, strategies, arbitrarily nested experiments (`A → A1 → A1A → A1AA…`), evidence, research references, validation runs, and an append-only audit timeline. Survives restarts; failed attempts are never overwritten.
- **Search before retrying** — exact error fingerprints (normalized: paths/timestamps/ports/UUIDs stripped) + full-text search across incidents and attempts, with relevance explanations and honest "history unavailable" reporting.
- **Differentiated experiments** — variants must declare `reason_for_difference`; near-duplicate/equivalent attempts are flagged with prior outcome context.
- **Evidence discipline** — raw observations stored (redacted, size-bounded) separately from AI interpretations; capture completeness disclosed.
- **Verified resolution only** — `verified` can only be set by a validation run whose acceptance criteria passed; resolving an incident requires a qualifying validation. A green command is not a fix.
- **Adaptive engine (v0.2)** — configurable exploration budgets (enforced at creation, resumable via recorded overrides/handoffs), exhaustion detection of the *tracked* search space (never the conceivable one), evidence-ranked refinement candidates, and a structured one-action-next recommendation after every outcome.
- **Safety** — secret redaction before persistence and indexing, project-scoped isolation (cross-project search is opt-in), idempotent writes, transition validation, no command execution from memory.

## Repository layout

```
src/
  server/        MCP stdio server: protocol, transport, tool catalog
  server/tools/  Tool handlers (case, search, plan, attempt, evidence, tree, validation, meta)
  memory/        SQLite schema, migrations, Store (single persistence interface)
  retrieval/     fingerprint normalization, FTS search + ranking, duplicate detection
  security/      secret redaction
  engine/        adaptive engine: exploration budgets, exhaustion detection, candidate ranking, next-action
  experiments/   (tree logic lives in memory/store.ts; see buildTree)
plugin/          OpenCode observation plugin (observation-only)
.opencode/       Agent, AGENTS.md rules, skill, slash commands (packaged templates; the live install is global)
tests/           unit / integration / fixtures / stdio smoke
opencode.jsonc.example
```

## Requirements

- [Bun](https://bun.sh) ≥ 1.0 (runs the server and plugin; `bun:sqlite` with FTS5)
- OpenCode **v2** CLI (to host the agent + MCP; v1 config schemas do not apply)
- Windows, macOS, or Linux (developed and smoke-tested on Windows)

## Quick start

```powershell
bun install
bun test                    # 73 tests: unit, integration, and the 14-scenario adaptive evaluation
bun run tests/smoke/stdio-smoke.ts   # full MCP lifecycle over stdio (31 checks, hermetic temp db)
bun run tests/smoke/obs-check.ts      # inspect live plugin observations in the default DB (alias: bun run obs-check)
bun run src/server/index.ts --db "$env:TEMP\debug-memory.db"   # run the server manually
```

## Register in OpenCode (v2)

> **This machine is already set up — globally.** The server lives under `mcp.servers` in `~/.config/opencode/opencode.json`. The plugin is **not** registered through the config `plugins` array — it is auto-discovered from `~/.config/opencode/plugins/adaptive-debug-observer.ts` (see step 2). The agent/skill/commands live in `~/.config/opencode/{agents,skills,commands}/`. Every project sees them.

To reproduce elsewhere (OpenCode **v2** — v1 schemas do not apply):

1. Register the MCP server (the CLI writes the v2-canonical `mcp.servers` entry):
   ```sh
   opencode mcp add adaptive-debug-memory -- bun run /abs/path/adaptive-debugging-mcp/src/server/index.ts
   # add --global to make it available in every project
   ```
2. Register the observation plugin. **In v2.0.27 the config `plugins` array only accepts directories** — a `plugin/index.ts` file path there is rejected at every plugin reconciliation with `configured plugin path must be a directory` and never loads (46 such warnings in the host log before this was characterized; incident `inc_mv6e7w70…`). For a *file* entrypoint, use auto-discovery instead: put a tiny loader `.ts` in the global plugins directory, `~/.config/opencode/plugins/adaptive-debug-observer.ts`:
   ```ts
   import AdaptiveDebugObserver from "file:///C:/Adaptive%20Debugging%20MCP/adaptive-debugging-mcp/plugin/index.ts";
   export const AdaptiveDebugObserverPlugin = AdaptiveDebugObserver;
   export default AdaptiveDebugObserver;
   ```
   **Use an absolute `file://` URL (percent-encoding the space) — not a relative specifier.** The global plugins directory and the repo sit on different filesystem branches, so no fixed number of `../` segments is safe; the wrong count produces `Cannot find module '...'` on every plugin load (`err_2f7ed852`, 4,895 failures before the fix, zero after). `@opencode/plugin` still resolves from the repo's own `node_modules` because the import is resolved relative to the canonical file.
3. Copy `.opencode/agents/deep-debug.md`, `.opencode/skills/deep-debug/`, and `.opencode/commands/*.md` into `~/.config/opencode/` (global) or a project's `.opencode/`.
4. Restart OpenCode (`opencode service restart` also picks up plugin changes), then verify:
   ```sh
   opencode mcp list                      # → ✓ adaptive-debug-memory connected
   bun run tests/smoke/obs-check.ts       # → plugin observations appear after any tool call
   ```

The database lives at `%APPDATA%\adaptive-debugging-mcp\debug-memory.db` by default (macOS/Linux: `~/.local/share/...`); the server and plugin resolve the same default, so pin `ADAPTIVE_DEBUG_DB_PATH` globally to move it for both.

**Known OpenCode behavior (not a bug here):** the first `opencode mcp list` from a folder OpenCode has never seen prints `No MCP servers configured` — for *all* servers, including global ones — until per-directory initialization completes (~1–2 minutes; fast retries keep showing it). Wait a minute and re-run. Characterized and validated against incident `inc_mv53g4qq…` in the memory DB.

In Code Mode the tools appear as `tools["adaptive-debug-memory"].<tool>` (17 tools).

## MCP tools

**Core nine** (per the Tool Catalogue MVP):

| Tool | Purpose |
|---|---|
| `debug_case_start` | Open an incident with baseline, fingerprints, acceptance criteria; suggests related cases, never auto-merges |
| `debug_history_search` | Fingerprint + full-text retrieval of prior incidents/attempts with match explanations |
| `debug_case_read` | Authoritative incident summary (observed vs interpretation kept distinct) |
| `debug_attempt_create` | Plan a strategy/experiment/variant node (variants require `reason_for_difference`) |
| `debug_evidence_record` | Attach redacted, size-bounded raw observations |
| `debug_attempt_update` | Record execution/outcome with audit trail (`verified` is blocked here) |
| `debug_tree_read` | Nested branch tree with status counts and truncation disclosure |
| `debug_validation_record` | Acceptance-criteria validation; the only path to `verified` |
| `debug_case_status_update` | Lifecycle transitions (requires qualifying validation for `resolved`) |

**Supporting:** `debug_hypothesis_manage`, `debug_research_record`, `debug_timeline_read`, `debug_case_link`, `debug_data_export`, `debug_server_health`.

**Adaptive decision layer (v0.2):** `debug_next_experiment_prepare` — assesses exhaustion, reports budget usage, ranks refinement candidates with explained heuristic factors (not probabilities), and recommends exactly ONE next action with its supporting evidence, unresolved uncertainty, expected observation, risk/cost, and what would change the decision; when a hard budget is reached it returns and durably records a resumable handoff. `debug_budget_manage` — view effective config/usage/next-experiment probe, set project defaults or per-incident overrides (incident changes recorded in the audit timeline). 17 tools total.

Errors use machine-readable categories: `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `STORAGE_ERROR`, `LIMIT_EXCEEDED`, … (see `src/errors.ts`).

## Outcome vocabulary

- Execution: `not_started | running | completed | interrupted | failed_to_execute`
- Outcome: `pending | failed | inconclusive | partial | blocked | candidate | verified | superseded | not_applicable`
- Incident: `open | investigating | blocked | resolved | closed_unresolved | reopened`

A command can complete (`completed`) while its outcome is `failed` (bug remains) — these are tracked separately on purpose.

## Adaptive engine (v0.2)

- **Exhaustion detection** — computed states integrate with the incident lifecycle (no new status fields): `exploring`, `refinement_required`, `research_required`, `budget_exhausted`, `blocked`, `resolved`. Pending/running/interrupted/inconclusive work always blocks exhaustion and is never silently classified as failed. `search_space_exhausted` only ever means *the defined, currently tracked paths within configured limits* — never that every conceivable solution was explored; new hypotheses or evidence reopen the search.
- **Candidate ranking** — failed/partial attempts scored by explainable heuristic factors: partial improvement (+30), changed environment (+15), informative failure (+10), live hypothesis (+10), research linkage (+6), evidence backing (+5), low risk (+4), duplicate-proximity penalty (−6 per similar failure, capped). No recency factor. Interrupted/inconclusive attempts land in a separate re-run bucket. Scores are explicitly heuristics, not probabilities.
- **Budgets** — defaults: 3 attempts per strategy family, 3 variants per parent, 25 experiments per investigation, refinement depth 3, no duration limit, risk ceiling `medium` (advisory — approvals live in the host permission layer). Over-limit creation returns `LIMIT_EXCEEDED` with the limit, current usage, and how to proceed; raising a budget or adding evidence resumes the investigation. Effective config is snapshotted into the incident's timeline at creation. Note: with the default family budget of 3, a depth-3 refinement chain inside one family requires a family-budget bump — defaults are provisional and overridable per project/incident.
- **Cost limits** are accepted, stored, and reported but **not enforced**: ADIM has no reliable token/monetary accounting, so no figures are invented.

## The observation plugin (optional)

`plugin/index.ts` subscribes to tool executions and **session-level failure events** through the **v2 plugin API** (`Plugin.define` → `ctx.tool.hook("execute.before"/"execute.after")` + `ctx.event.subscribe`), with a v1 `server()` hook map kept in the same dual export for older hosts. It writes redacted, deduplicated observations to the same database without blocking your workflow. It records only what the hooks actually expose, marks incomplete captures as incomplete, skips the memory server's own `debug_*` operations (already persisted by the MCP server), and **does not** correlate events to incidents it cannot identify — never claiming to see terminals, editors, or commands outside OpenCode's boundary. It is observation-only: it executes nothing. Verify it live with `bun run obs-check`.

**Which session events it actually captures (verified against v2.0.27, not assumed from docs):** a live session driven against a local 401 responder delivered 68 events and contained **zero** `session.error` — the host publishes `session.execution.failed` and `session.step.failed` instead, and both carry the session id nested at `data.sessionID`, not at the top level. The plugin therefore persists all three of `session.error`, `session.execution.failed` and `session.step.failed` (keeping the first for forward compatibility), records `kind` as the real event type, and reads the session id from `data.sessionID` with legacy top-level fallbacks. A tool or MCP error is **not** one of these — a failing `shell` command surfaces as a `tool.execute.after` row with `status=error`, which is a different, already-correct path. Both event kinds were verified live: an isolated 401 run persisted 2 rows with the real session id (`inc_mv6pxnhb…`), and the running host captured real `session.step.failed` rows afterwards.

## Safety properties (tested)

- Secrets (AWS/GitHub/OpenAI/Slack keys, JWTs, bearer tokens, private keys, `password=`/`token=` pairs, connection strings) are redacted before storage **and** indexing (`tests/unit/redaction.test.ts`, integration search assertions).
- Evidence is size-bounded (64 KB) with disclosed truncation.
- Project isolation by default; cross-project search is explicit opt-in.
- Duplicate event delivery does not create duplicate records (idempotency keys / unique event keys).
- Invalid parents, cross-incident attachment, and invalid transitions are rejected; history is append-only.
- A `verified` outcome is immutable to ordinary updates: downgrades return a machine-readable `CONFLICT`; only a failing re-validation can regress a verified fix (auditably, with an `experiment.outcome.regressed` timeline event), and only a passing validation can set `verified`.
- Resolving an incident stamps `resolution_experiment_id` derived from the qualifying validation run — invalid or missing verification references are rejected with the incident state preserved.
- Interrupted writes roll back (SQLite transactions); nothing reports success without a durable commit.

## Design boundaries

- The MCP server records, retrieves, and enforces rules. It never runs commands, never auto-applies historical fixes, and treats logs/repository/web content as untrusted data.
- The plugin observes supported hooks only; the agent (`.opencode/agents/deep-debug.md` + skill) does the reasoning and uses OpenCode's own execution tools under configured permissions.
- No embeddings, vector DB, dashboard, or remote service in the MVP — by design. Add them only when a measured need appears (see the Development Roadmap).

## Extending

- Migrations are ordered steps in `src/memory/db.ts` (`SCHEMA_VERSION` = 3; the v3 `budgets` table is additive — v2 databases migrate in place with records intact, covered by tests).
- The Store (`src/memory/store.ts`) is the single persistence interface shared by MCP tools and the plugin.
- `BUILD_CHECKLIST.md` tracks build state; the parent directory's `Adaptive_Debugging_MCP_*.md` planning documents hold the full specifications.
