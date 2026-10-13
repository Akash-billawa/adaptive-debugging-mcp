---
description: Resume an existing debugging investigation
---

Resume the debugging investigation: $ARGUMENTS

If an incident id was given, use it; otherwise find it with `debug_history_search`.

1. `debug_case_read` the incident with sections attempts, hypotheses, timeline, validations.
2. `debug_tree_read` the full branch tree; identify which outcomes are pending/inconclusive and which branches are untested.
3. Summarize: what previous outcomes established, what remains uncertain, and which prior failures still apply under today's environment (note any environment changes).
4. Propose the next experiment with an explicit reason it differs from prior attempts, then continue the loop: record → execute → record outcome → adapt.

Do not repeat an equivalent experiment without new evidence or a changed condition.
