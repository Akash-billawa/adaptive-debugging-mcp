---
description: Resume an existing debugging investigation and implementation
---

Resume the debugging investigation: $ARGUMENTS

If an incident id was given, use it; otherwise find it with `debug_history_search`.

1. `debug_case_read` the incident with attempts, hypotheses, timeline, validations.
2. `debug_next_experiment_prepare` and `debug_tree_read` the full branch tree; identify pending/inconclusive outcomes, budget usage, and untested branches.
3. Summarize: previous outcomes, current uncertainties, and applicable branches.
4. Propose the next experiment with `reason_for_difference` and record via `debug_attempt_create`.
5. Continue the workflow: inspect code → implement minimal fix when authorized → run tests → record evidence → validate resolution.
