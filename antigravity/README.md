# Adaptive Debugging Intelligence — Antigravity Plugin

This directory contains the canonical integration package for **Google Antigravity**, installed at `~/.gemini/config/plugins/adaptive-debugging/`.

## Components

- **Agent (`agents/deep-debug.md`)**: The adaptive debugging investigator. Frontmatter uses only keys verified against the installed Antigravity and Google's own plugin agents: `name`, `description`, `mainAgent: true`, `subagent: true`, `commandExecutionPolicy: auto`.
- **Skill (`skills/deep-debug/SKILL.md`)**: The end-to-end deep-debugging procedure covering history search, hypothesis formulation, budget planning, code inspection, fix implementation or handoff, test execution, validation gating, and multi-session safety.
- **Rules (`rules/AGENTS.md`)**: Project rules defining boundaries, required validation before marking resolved, and accurate reporting of missing host capabilities.
- **MCP Config (`mcp_config.json`)**: Launches the `adaptive-debug-memory` server (`bun run .../src/server/index.ts`).

## Supported architecture (verified 2026-10-14)

**ADIM provides debugging history, evidence, budgets, and validation. The coding-capable host agent (Antigravity's Agent Mode lead, or the user) performs file edits and command execution.**

This architecture is a verified constraint, not a preference:

- The agent frontmatter schema (verified against Google's own `flutter/agents/a11y_agent.md` and the builtin `agy-customizations` docs) supports `name`, `description`, `mainAgent`, `subagent`, and `commandExecutionPolicy` **only**.
- There is **no supported `tools:` frontmatter declaration** for plugin agents, and **no `enable_write_tools` / `enable_mcp_tools` setting exists** anywhere in official Antigravity artifacts (checked: all official plugins, builtin docs, and `config.json`). An earlier version of this README claimed those flags were configured — that claim was incorrect and has been removed.
- The IDE's file-editing and terminal tools are not guaranteed to be bound to custom agents. The deep-debug agent therefore checks its **actual runtime tool declarations** each session: when editing/execution tools are absent, it produces a structured, implementation-ready handoff (exact file changes, exact commands, acceptance criteria, safety notes) for the coding-capable host, and records the attempt as `blocked`/`candidate` with the missing capabilities named.
- The agent's final response IS the handoff. No tool-based upstream delegation is assumed.

## Installation into Antigravity

Copy this directory into `~/.gemini/config/plugins/adaptive-debugging/`:

```powershell
Copy-Item -Recurse "C:\Adaptive Debugging MCP\adaptive-debugging-mcp\antigravity\*" "$HOME\.gemini\config\plugins\adaptive-debugging\"
```

The plugin is enabled through Antigravity's plugin settings (recorded in `~/.gemini/config/config.json` under `plugins.adaptive-debugging.enabled`).

## What was verified vs. what was not

Verified locally: plugin discovery and enablement, MCP server launch (`adaptive-debug-memory`, 17 tools), the agent frontmatter schema above (against Google's own examples), and the absence of any official tool-binding flags.

Not verifiable from this repository: which exact tool names the IDE binds to a custom agent in every context — this can vary by Antigravity version and agent context. The agent instructions therefore never hard-require specific host tool names; they adapt to whatever the runtime declares. If a future Antigravity release documents a supported per-agent tool or capability declaration, re-evaluate then — with evidence.
