# Haiku context canary, 2026-11-02

3 of 3 runs were accepted, at a mean of $0.32. This counts toward no claim.

All 3 runs started on Sonnet, so the 150k limit was not exercised live. `tests/scenarios.test.ts` and `tests/policy-audit.test.ts` cover it. The mean misses the $0.30 rule as written, and the cause is the route, not the limit. The same prompt started on Haiku in `classify-canary`, so the judges are noisy on this task.
