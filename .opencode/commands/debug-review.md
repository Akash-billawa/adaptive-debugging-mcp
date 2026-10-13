---
description: Postmortem/review of a resolved or closed investigation
---

Produce a postmortem for the incident: $ARGUMENTS

1. `debug_case_read` with all sections; `debug_timeline_read` for the audit trail.
2. Write the review:
   - Original symptom and acceptance criteria.
   - The resolution path: which experiment verified it, with evidence references.
   - What earlier failures established and why they failed (the lesson).
   - Any caveats: environment-specific applicability, skipped criteria, limitations noted in the validation.
3. If anything is unverified or contradictory, flag it explicitly — do not rubber-stamp a resolution.
