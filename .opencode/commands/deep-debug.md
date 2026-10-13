---
description: Start a structured deep-debugging investigation of a bug
---

Begin a deep debugging investigation for: $ARGUMENTS

Follow the deep-debug skill and the adaptive debugging agent rules:

1. `debug_case_start` — record the incident with the exact error text (so fingerprints are derived), reproduction status, relevant environment, and explicit acceptance criteria. Check `related_case_suggestions` first; resume an existing incident rather than duplicating it.
2. `debug_history_search` — retrieve prior related attempts before proposing anything.
3. Form 2+ competing hypotheses, then design and rank meaningfully different candidate experiments (state what each changes and why it matters).
4. Show me the plan and your chosen first experiment before executing anything risky.

Do not mark anything fixed; validation comes later against the acceptance criteria.
