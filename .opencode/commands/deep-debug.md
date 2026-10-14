---
description: Start a structured deep-debugging investigation and fix of a bug
---

Begin a deep debugging investigation for: $ARGUMENTS

Follow the deep-debug skill and adaptive debugging rules:

1. `debug_case_start` — record the incident with exact error text (so fingerprints are derived), reproduction status, relevant environment, and explicit acceptance criteria. Check `related_case_suggestions` first; resume an existing incident rather than duplicating it.
2. `debug_history_search` — retrieve prior related attempts before proposing anything.
3. Form 2+ competing hypotheses with `debug_hypothesis_manage`, probe budgets with `debug_next_experiment_prepare`, and design a justified experiment with `debug_attempt_create`.
4. Inspect the affected source code and reproduction tests using native reading tools.
5. With user approval and available host editing tools, implement a minimal fix. If host tools are missing, report missing capabilities and provide the diagnostic patch.
6. Execute relevant tests with native tools, inspect real output, and record raw evidence via `debug_evidence_record`.
7. Record attempt outcome via `debug_attempt_update`. Verify against acceptance criteria via `debug_validation_record`, then update status via `debug_case_status_update`.
8. Recheck incident state before write batches to maintain multi-session safety.
