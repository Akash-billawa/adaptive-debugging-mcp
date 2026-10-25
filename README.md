<p align="center">
  <img src="assets/hero-banner.jpg" alt="Adaptive Debugging Intelligence MCP Banner" width="100%" />
</p>

<p align="center">
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Runtime-Bun%20%E2%89%A5%201.0-FBF0DF?style=for-the-badge&logo=bun&logoColor=black" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/Language-TypeScript%205.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/Protocol-MCP%20Standard-412991?style=for-the-badge&logo=anthropic&logoColor=white" alt="MCP Protocol"></a>
  <a href="https://sqlite.org/"><img src="https://img.shields.io/badge/Engine-SQLite%20FTS5%20%2B%20Vectors-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite FTS5"></a>
  <a href="#test-suite--evaluations"><img src="https://img.shields.io/badge/Tests-138%20Passing-success?style=for-the-badge&logo=checkmarx&logoColor=white" alt="Tests"></a>
  <a href="#security--safety"><img src="https://img.shields.io/badge/Security-Secret%20Redaction%20Active-blueviolet?style=for-the-badge&logo=shield&logoColor=white" alt="Security Redaction"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-emerald?style=for-the-badge" alt="License: MIT"></a>
</p>

<h1 align="center">Adaptive Debugging Intelligence MCP (ADIM)</h1>

<p align="center">
  <strong>A persistent, cognitive debugging memory and adaptive exploration system for AI coding agents.</strong><br>
  Built for <a href="https://opencode.ai/">OpenCode CLI (v2)</a> and <a href="https://antigravity.google/">Google Antigravity IDE</a>.<br>
  <em>Investigate difficult, non-trivial bugs without repeating mistakes, without hallucinating success, and with mathematical verification.</em>
</p>

---

> [!IMPORTANT]
> **The Core Philosophy of Adaptive Debugging:**
> Debugging is an adaptive cognitive search across hypotheses—**not a blind retry loop**. When an AI agent encounters a failure, it must not repeat the same one-line edit. It must understand what prior attempts established, explore competing root causes, branch with explicit justification (`reason_for_difference`), respect exploration budgets, separate raw telemetry from subjective interpretation, and **never declare an issue fixed without proving it against acceptance criteria.**

---

## 📑 Table of Contents

- [The Paradigm Shift: Traditional vs. Adaptive](#-the-paradigm-shift-traditional-vs-adaptive)
- [System Architecture & Cognitive Cycle](#-system-architecture--cognitive-cycle)
- [Complete System Mind Map](#-complete-system-mind-map)
- [Interactive Visual Dashboard & Telemetry](#-interactive-visual-dashboard--telemetry)
- [Comprehensive Tool Catalog (22 Tools)](#-comprehensive-tool-catalog-22-tools)
- [Experiment Branching & Outcome Vocabulary](#-experiment-branching--outcome-vocabulary)
- [Quick Start & Setup](#-quick-start--setup)
- [Host Integration Guides](#-host-integration-guides)
  - [OpenCode CLI (v2)](#opencode-cli-v2)
  - [Antigravity IDE](#antigravity-ide)
- [Database Maintenance & Backup Lifecycle](#-database-maintenance--backup-lifecycle)
- [Security, Redaction & Safety Properties](#-security-redaction--safety-properties)
- [Test Suite & Evaluations](#-test-suite--evaluations)
- [Repository Structure](#-repository-structure)
- [License & Community](#-license--community)

---

## ⚡ The Paradigm Shift: Traditional vs. Adaptive

| Dimension | Traditional LLM Debugging | Adaptive Debugging Intelligence MCP |
| :--- | :--- | :--- |
| **Memory & Context** | Amnesiac. Re-starts from scratch on session loss or context overflow. | **Persistent SQLite WAL storage** with normalized error fingerprints & vector search. |
| **Exploration Strategy** | Blind linear retry. Edits the same file 5 times hoping for a pass. | **Arbitrary experiment trees** (`A → A1 → A1A`), competing hypotheses, and budget limits. |
| **Evidence Discipline** | Conflates LLM guesses with terminal facts. | **Strict separation** of raw redacted tool output from AI diagnostic interpretation. |
| **Duplicate Prevention** | None. Repeats identical failures across branches. | **Normalized fingerprint hashing & semantic similarity** flags duplicate attempts instantly. |
| **Verification Gate** | "Exit code 0" on arbitrary command assumed to be a fix. | **Immutable verification gate.** `verified` is only granted by passing original acceptance criteria. |
| **Safety & Privacy** | Accidental credential leakage in chat histories. | **Autonomous regex engine** redacts API keys, JWTs, bearer tokens, and private keys pre-storage. |

---

## 🏛️ System Architecture & Cognitive Cycle

The Adaptive Debugging Intelligence MCP coordinates between durable local persistence, the host AI agent, and real-time execution hooks.

<p align="center">
  <img src="assets/architecture-diagram.jpg" alt="Cognitive AI Debugging Architecture Diagram" width="100%" />
</p>

### The 5 Cognitive Modules

1. **Module 1: Incident Intake & Error Fingerprints**
   - Automatically normalizes error messages by stripping volatile noise (file paths, timestamps, ports, thread IDs, memory addresses).
   - Generates deterministic error fingerprints and stack signatures for instant cross-session matching.
   - Defines crisp, testable acceptance criteria upfront.

2. **Module 2: Persistent Memory & Hybrid Vector Search**
   - Single-file SQLite WAL persistence with FTS5 BM25 text ranking and local dense vector embeddings.
   - Project-scoped by default for hermetic isolation, with deliberate opt-in cross-project knowledge discovery.
   - Append-only audit timeline: no historical failure is ever silently overwritten or erased.

3. **Module 3: Hypotheses & Adaptive Decision Engine**
   - Formulates 2+ competing hypotheses before recommending code edits.
   - Analyzes codebase manifests, git blame, and diff histories safely.
   - Evaluates external technical research, detecting documentation discrepancies and version conflicts.
   - Provides an explainable **One-Action-Next** recommendation (`debug_next_experiment_prepare`).

4. **Module 4: Budgeted Experiment Trees**
   - Structures investigation paths into families and nested variants (`A → A1 → A1A → A1AA`).
   - Requires every variant to document an explicit `reason_for_difference`.
   - Enforces configurable exploration budgets (depth, attempt counts, family branches) to prevent infinite rabbit holes.

5. **Module 5: Acceptance Verification & Evidence Telemetry**
   - Size-bounded (64 KB) raw evidence capture with automatic credential redaction.
   - Strict outcome vocabulary (`pending`, `failed`, `inconclusive`, `partial`, `candidate`, `verified`, `blocked`).
   - Immutable resolution barrier: `debug_case_status_update(status='resolved')` strictly requires a passing `debug_validation_record`.

---

## 🧠 Complete System Mind Map

Below is the complete architectural mind map representing the cognitive capabilities, workflows, and safeguards built into the system.

```mermaid
mindmap
  root((Adaptive Debugging Intelligence))
    Mission and Principles
      Learn from every experiment
      Create meaningfully different variants
      Never lose failure history
      Reason from evidence not repetition
      Separate facts from hypotheses
      Verify original failure is resolved
      Report uncertainty and remaining paths
    Incident Intake
      Normalized error fingerprints
      Stack trace signatures
      Reproduction baseline
      Project and workspace identity
      Environment snapshot
      Explicit acceptance criteria
    Observation and Telemetry
      Tool inputs and outputs
      Standard output and standard error
      Exception signatures
      Code diffs and blame
      Secret redaction engine
      Output size bounding
      Incomplete capture disclosure
    Adaptive Reasoning Engine
      Normalized history retrieval
      Separate symptoms from root causes
      Extract hidden assumptions
      Compare prior outcomes
      Challenge previous reasoning
      Seek disconfirming evidence
      Single next action recommendation
    Solution Space Explorer
      Competing root cause hypotheses
      Strategy families Fix A Fix B Fix C
      Experiment branches A1 A2 A1A A1AA
      Arbitrary tree nesting
      Explicit difference justification
      Duplicate attempt detection
    Candidate Ranking and Budgets
      Explainable heuristic scoring
      Informative failure bonuses
      Duplicate proximity penalties
      Configurable exploration budgets
      Tracked search space exhaustion
      Human approval for high impact
    Technical Research Integration
      Official documentation ranking
      API and runtime references
      Codebase blame and manifest analysis
      Changelogs and issue trackers
      Contradiction detection
      External text treated as untrusted
    Verification and Resolution
      Explicit acceptance conditions
      Original reproduction re testing
      Regression suite execution
      Passing validation record required
      Command success distinct from fix
      Immutable verified status
    Persistence and Data Lifecycle
      Local SQLite WAL engine
      FTS5 full text indexing
      Local dense vector embeddings
      Append only audit timeline
      Atomic snapshot backups
      Safe pre restore snapshots
    Host Integrations and Security
      OpenCode v2 CLI MCP protocol
      OpenCode non blocking plugin
      Antigravity IDE deep debug agent
      Local first operation
      Project scoped isolation
      Credential redaction
```

### Cognitive State Loop

```mermaid
graph TD
    A[🔴 Incident Intake & Error Fingerprint] --> B[🔍 Hybrid Search: FTS5 + Semantic Vectors]
    B --> C{Prior Solution Found?}
    C -- High-Confidence Match --> D[🧪 Plan Targeted Reproduction & Validation]
    C -- Novel Bug / Variant --> E[🧠 Formulate 2+ Competing Hypotheses]
    E --> F[📚 Technical Research & Manifest Analysis]
    F --> G[🎯 Adaptive Engine: Score & Rank Candidates]
    G --> H[🌳 Create Differentiated Experiment Node A1/A1A]
    H --> I[⚙️ Execute Controlled Attempt via Host Agent]
    I --> J[📡 Capture Redacted Evidence & Telemetry]
    J --> K{Observed Outcome?}
    K -- Failed / Partial / Inconclusive --> L[📊 Record Evidence & Update Exhaustion Matrix]
    L --> G
    K -- Candidate Fix Observed --> M[🛡️ Run Acceptance Criteria Validation]
    M -- Validation Failed --> L
    M -- Validation Passed --> N[✅ Stamp Immutable Verified & Resolve Case]

    style A fill:#1e1e2e,stroke:#f38ba8,stroke-width:2px,color:#fff
    style B fill:#1e1e2e,stroke:#89b4fa,stroke-width:2px,color:#fff
    style E fill:#1e1e2e,stroke:#cba6f7,stroke-width:2px,color:#fff
    style G fill:#1e1e2e,stroke:#fab387,stroke-width:2px,color:#fff
    style H fill:#1e1e2e,stroke:#f9e2af,stroke-width:2px,color:#fff
    style M fill:#1e1e2e,stroke:#a6e3a1,stroke-width:2px,color:#fff
    style N fill:#1e1e2e,stroke:#94e2d5,stroke-width:3px,color:#fff
```

---

## 🖥️ Interactive Visual Dashboard & Telemetry

The Adaptive Debugging Intelligence MCP features an interactive visual memory dashboard. View historical experiment trees, telemetry graphs, redacted logs, and hypothesis confidence matrices directly in your browser.

<p align="center">
  <img src="assets/dashboard-preview.jpg" alt="Adaptive Debugging Visual Dashboard & Telemetry" width="100%" />
</p>

### Accessing the Dashboard:

```powershell
# Launch the standalone interactive dashboard
bun run db:dashboard

# Or export hermetic, zero-dependency HTML reports via CLI
bun run src/server/index.ts --export-html report.html

# Or via MCP Tool in your agent session
tools["adaptive-debug-memory"].debug_data_export({ format: "html", incident_id: "inc_..." })
```

---

## 🧰 Comprehensive Tool Catalog (22 Tools)

The system exposes 22 tightly integrated Model Context Protocol (MCP) tools, fully compatible with OpenCode CLI and Antigravity IDE:

### 🏛️ 1. Incident & Lifecycle Management
| Tool | Description | Key Arguments |
| :--- | :--- | :--- |
| `debug_case_start` | Opens an incident with normalized fingerprints, baseline environment, and acceptance criteria. Suggests related cases. | `title`, `problem_statement`, `acceptance_criteria`, `symptoms` |
| `debug_case_read` | Retrieves the authoritative case file, keeping observed facts and AI interpretations separated. | `id` |
| `debug_case_status_update` | Performs lifecycle transitions (`open`, `investigating`, `blocked`, `resolved`). **Requires valid validation run to resolve.** | `id`, `status`, `reason`, `validation_id` |
| `debug_case_link` | Links related incidents across projects or strategies without merging them. | `source_id`, `target_id`, `link_type`, `rationale` |

### 🔍 2. Retrieval & Semantic Memory
| Tool | Description | Key Arguments |
| :--- | :--- | :--- |
| `debug_history_search` | Hybrid retrieval (normalized fingerprint + FTS5 BM25 + dense vector embeddings) with match explanations. | `query`, `fingerprint`, `project_id`, `include_cross_project` |
| `debug_semantic_index` | Synchronizes vector embeddings for cases, hypotheses, and evidence with status reporting. | `action` (`status` \| `sync` \| `rebuild`), `project_id` |
| `debug_timeline_read` | Reads an append-only audit trail of every status transition, override, and recorded event. | `incident_id`, `limit` |

### 🧠 3. Hypotheses & Technical Research
| Tool | Description | Key Arguments |
| :--- | :--- | :--- |
| `debug_hypothesis_manage` | Creates, tests, strengthens, weakens, or rejects competing root-cause hypotheses. | `action`, `statement`, `rationale`, `status` |
| `debug_research_plan` | Decomposes error tokens and hypotheses into targeted research questions and source queries. | `incident_id`, `scope` |
| `debug_codebase_analyze` | Inspects project manifests (`package.json`, `pyproject.toml`), git blame, and diff histories safely. | `action`, `paths`, `commit_range` |
| `debug_research_evaluate` | Ranks external documentation sources and automatically detects contradictions or version gaps. | `incident_id`, `sources` |

### 🧪 4. Experiment Trees & Raw Telemetry
| Tool | Description | Key Arguments |
| :--- | :--- | :--- |
| `debug_attempt_create` | Plans a strategy (`A`), experiment (`A1`), or nested variant (`A1A`). **Variants require `reason_for_difference`.** | `incident_id`, `parent_id`, `hypothesis_id`, `reason_for_difference` |
| `debug_evidence_record` | Attaches raw, redacted observations (CLI stdout/stderr, stack traces, diffs) bounded at 64 KB. | `attempt_id`, `evidence_type`, `content`, `metadata` |
| `debug_attempt_update` | Records execution lifecycle and outcomes (`pending`, `failed`, `partial`, `candidate`, `blocked`). | `id`, `execution_status`, `outcome`, `rationale` |
| `debug_tree_read` | Renders the complete nested experiment hierarchy with status badges and truncation disclosure. | `incident_id`, `include_evidence` |

### 🎯 5. Adaptive Decision Engine & Budgets
| Tool | Description | Key Arguments |
| :--- | :--- | :--- |
| `debug_next_experiment_prepare` | Computes search space exhaustion, scores candidate hypotheses, and outputs **one recommended next action**. | `incident_id` |
| `debug_budget_manage` | Inspects remaining exploration limits or records an audited budget bump override. | `incident_id`, `action`, `overrides` |
| `debug_candidate_compare` | Renders a side-by-side proposal comparison matrix with heuristic trade-offs and duplicate warnings. | `incident_id`, `candidate_a`, `candidate_b` |

### ✅ 6. Verification, Export & Server Health
| Tool | Description | Key Arguments |
| :--- | :--- | :--- |
| `debug_validation_record` | Validates fix against explicit acceptance criteria. **The only mechanism that yields `verified`.** | `incident_id`, `attempt_id`, `criteria_results`, `notes` |
| `debug_data_export` | Exports full case data to JSON or interactive standalone HTML dashboards. | `incident_id`, `format` (`json` \| `html`) |
| `debug_server_health` | Reports SQLite storage stats, migration version (v4), vector count, and memory engine status. | None |

---

## 🌲 Experiment Branching & Outcome Vocabulary

### The Nested Hierarchy

Experiments are tracked as arbitrary trees with deterministic labeling:

```
Family Strategy A: "Inspect and update native dynamic library binding"
│
├── A1: "Rebuild C FFI binary with position-independent code (PIC)" ── [FAILED]
│   └── ↳ Observation: Relocation error eliminated, but symbol lookup fails on undefined symbol '_init_buffer'.
│
├── A1A: "Export '_init_buffer' symbol via linker version script" ────── [FAILED]
│   │   ↳ Reason for Difference: "Directly addresses undefined symbol observed in A1 output."
│   │   ↳ Observation: Symbol resolved, but crashes on Windows x64 ABI calling convention mismatch.
│   │
│   └── A1AA: "Annotate exported symbols with __cdecl calling convention" ── [CANDIDATE]
│       │   ↳ Reason for Difference: "Aligns ABI calling convention between MSVC and Bun FFI runtime."
│       │
│       └── 🛡️ Validation Run val_892k1... ── [VERIFIED FIX]
│           ↳ Acceptance Criteria: "All 138 unit tests and cross-platform FFI smoke suite exit with 0."
│
└── Strategy Family B: "Fallback to pure JavaScript WebAssembly bundle" ── [SUPERSEDED]
```

### Strict Status Matrices

#### Execution Status vs. Outcome Status
> A test run can **complete execution** without error (`completed`), yet the test itself **fails** (`failed`). The system enforces this critical distinction:

- **Execution State:** `not_started` ➔ `running` ➔ `completed` \| `interrupted` \| `failed_to_execute`
- **Outcome State:** `pending` ➔ `failed` \| `inconclusive` \| `partial` \| `blocked` ➔ `candidate` ➔ `verified` \| `superseded` \| `not_applicable`
- **Incident State:** `open` ➔ `investigating` ➔ `blocked` ➔ `resolved` (Requires `verified` validation) \| `reopened`

---

## 🚀 Quick Start & Setup

### Prerequisites
- [Bun](https://bun.sh) ≥ 1.0 (built on `bun:sqlite` with native FTS5 and vector operations)
- Node.js ≥ 18 (optional alternative)
- [OpenCode CLI (v2)](https://opencode.ai/) or [Google Antigravity IDE](https://antigravity.google/)

### Installation

```powershell
# Clone the repository
git clone https://github.com/Akash-billawa/adaptive-debugging-mcp.git
cd adaptive-debugging-mcp

# Install dependencies
bun install

# Run complete hermetic test suite (138 tests across 25 suites)
bun test

# Run stdio smoke verification (hermetic temp database)
bun run tests/smoke/stdio-smoke.ts

# Launch the visual dashboard
bun run db:dashboard
```

---

## 🔌 Host Integration Guides

### OpenCode CLI (v2)

OpenCode CLI v2 integrates with the MCP server and uses the background observation plugin.

#### 1. Add the MCP Server
```powershell
# Register the MCP server globally
opencode mcp add adaptive-debug-memory -- bun run C:/Adaptive%20Debugging%20MCP/adaptive-debugging-mcp/src/server/index.ts --global
```

#### 2. Register the Observation Plugin
In OpenCode v2.0.27+, the config `plugins` array requires a directory. For a file entrypoint, use auto-discovery by placing a loader in `~/.config/opencode/plugins/adaptive-debug-observer.ts`:

```typescript
import AdaptiveDebugObserver from "file:///C:/Adaptive%20Debugging%20MCP/adaptive-debugging-mcp/plugin/index.ts";
export const AdaptiveDebugObserverPlugin = AdaptiveDebugObserver;
export default AdaptiveDebugObserver;
```

#### 3. Install Agents and Skills
Copy the bundled templates into your global OpenCode configuration:
- `.opencode/agents/deep-debug.md` ➔ `~/.config/opencode/agents/`
- `.opencode/skills/deep-debug/` ➔ `~/.config/opencode/skills/`
- `.opencode/commands/*.md` ➔ `~/.config/opencode/commands/`

---

### Antigravity IDE

This repository includes first-class support for Google Antigravity IDE via the `antigravity/` configuration bundle:

```json
{
  "mcpServers": {
    "adaptive-debug-memory": {
      "command": "bun",
      "args": ["run", "C:/Adaptive Debugging MCP/adaptive-debugging-mcp/src/server/index.ts"]
    }
  }
}
```

The Antigravity deep-debug agent and skill automatically enforce:
1. `debug_history_search` before proposing fixes.
2. Formulating 2+ competing hypotheses before modifying files.
3. Recording all experiments in the tree.
4. Requiring `debug_validation_record` before closing tasks.

---

## 💾 Database Maintenance & Backup Lifecycle

The database lives at `%APPDATA%\adaptive-debugging-mcp\debug-memory.db` on Windows (`~/.local/share/adaptive-debugging-mcp/` on Unix).

```powershell
# 1. Create an atomic point-in-time snapshot with SHA-256 integrity manifest
bun run db:backup

# 2. Verify snapshot integrity and SHA-256 hash
bun run db:verify backups/debug-memory-snapshot-20261025.db

# 3. Restore snapshot (automatically creates a safety pre-restore backup first)
bun run db:restore backups/debug-memory-snapshot-20261025.db

# 4. Forecast or prune transient evidence and observations older than 30 days
bun run db:prune --dry-run
bun run db:prune --days 30
```

---

## 🔒 Security, Redaction & Safety Properties

Security and non-destructive operation are foundational architectural principles:

- **Automatic Secret Redaction:** All tool inputs, observations, logs, and stack traces pass through an aggressive regex redaction engine prior to database persistence and vector indexing. Redacts:
  - AWS Access/Secret Keys (`AKIA...`)
  - GitHub Personal Access Tokens (`ghp_...`, `github_pat_...`)
  - OpenAI / Anthropic API Keys (`sk-proj-...`, `sk-ant-...`)
  - Slack Tokens (`xoxb-...`, `xoxp-...`)
  - JSON Web Tokens (JWT) & `Authorization: Bearer` headers
  - Private Key Headers (`-----BEGIN RSA PRIVATE KEY-----`)
  - Database connection strings (`postgres://...`, `mongodb://...`)
- **64 KB Evidence Boundaries:** Raw observations are bounded at 64 KB per entry. Larger payloads are cleanly truncated with explicit `is_truncated: true` disclosure.
- **Untrusted External Data:** Git diffs, blame outputs, and technical web research are tagged `untrusted_data: true` to prevent prompt-injection attacks.
- **Sandboxed Memory Boundary:** The MCP server **never executes host shell commands** or writes files directly; all physical workspace modifications are performed solely by host agents under user-approved permissions.

---

## 🧪 Test Suite & Evaluations

The codebase is validated by 138 hermetic tests across 25 suites, including unit, integration, and scenario-based adaptive evaluations:

```
Ran 138 tests across 25 files. [3.24s]
Pass: 138 | Fail: 0 | Assertions: 885 expect() calls
```

### Key Verified Behaviors:
- **Restart Durability:** Store preserves all incident, hypothesis, tree, and evidence records across cold process restarts.
- **Differentiated Variations:** Nested branching (`A → A1 → A1A → A1AA`) strictly preserves failure records and duplicate proximity penalties.
- **Verification Integrity:** An attempt cannot be downgraded from `verified` by normal updates; only an explicit failing re-validation can regress it.
- **Budget Exhaustion:** Hard limits on exploration depths, variants-per-parent, and strategy counts prevent runaway token usage.
- **Semantic Hybrid Search:** Resolves related historical incidents even when error vocabularies and keywords diverge.

---

## 📂 Repository Structure

```
adaptive-debugging-mcp/
├── assets/                  # High-res diagrams, hero banners, and UI previews
│   ├── hero-banner.jpg
│   ├── architecture-diagram.jpg
│   └── dashboard-preview.jpg
├── src/
│   ├── server/              # MCP Server implementation, tool router, stdio transport
│   │   ├── tools/           # 22 MCP tool handler implementations
│   │   └── prompts.ts       # Canonical prompt workflows
│   ├── memory/              # SQLite database schema (v4), migrations, and Store interface
│   ├── engine/              # Adaptive decision engine: budgets, ranking, exhaustion detection
│   ├── retrieval/           # Fingerprint normalizer, FTS5 BM25 search, vector embeddings
│   ├── research/            # Documentation ranker, manifest analyzer, contradiction detector
│   ├── security/            # High-performance regex secret redaction engine
│   └── visual/              # Standalone HTML dashboard generator and visual data exporter
├── plugin/                  # OpenCode v2 non-blocking observation plugin
├── antigravity/             # Antigravity IDE configuration, agents, skills, and rules
├── .opencode/               # Packaged OpenCode agents, skills, and slash commands
├── tests/
│   ├── unit/                # Unit test suites (engine, vectors, redaction, manifests)
│   ├── integration/         # Multi-turn workflow, persistence, search, and research tests
│   └── smoke/               # Stdio MCP smoke tests and live observation verifiers
├── package.json
└── tsconfig.json
```

---

## 📜 License & Community

Distributed under the **MIT License**. See `LICENSE` for details.

- **Author & Maintainer:** [Akash Billawa](https://github.com/Akash-billawa)
- **Contributions:** Pull requests and issues are welcome! Please ensure all 138 tests pass (`bun test`) and stdio smoke checks pass before opening a PR.

<p align="center">
  <sub>Built with precision for the next generation of autonomous AI software engineering.</sub>
</p>
