---
description: Summarize tried, untried, blocked, and promising branches for an incident
---

Summarize the investigation status for: $ARGUMENTS

1. `debug_case_read` the incident and `debug_tree_read` its tree.
2. Report:
   - Counts by outcome (failed / inconclusive / partial / blocked / candidate / verified).
   - What the key evidence established, and which hypotheses are supported vs rejected.
   - Untested branches and the most promising next candidate, with a stated reason.
3. If the incident claims to be resolved, check `debug_validation_record` history: were the acceptance criteria really verified with evidence?
