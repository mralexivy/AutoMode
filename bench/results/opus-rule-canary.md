# Opus rule canary, 2026-11-02

This run counts toward no claim. It covers one model rule on 4 tasks. All costs are list-price equivalents.

| Task | Accepted | Model | Cost per run | Risk |
|---|---:|---|---:|---|
| `marked` | 2 of 2 | Sonnet | $0.16 | elevated |
| `tomli` | 1 of 1 | Sonnet | $0.18 (Opus before: $0.62) | elevated |
| `dnspython` | 2 of 2 | Opus, Sonnet reviewer | $1.29 | critical |
| `sqlglot` | 0 of 1, plus 1 timeout | Opus | $2.55 | critical |

## First run

`opus-rule-canary-flag-bug.jsonl` holds the first run. `sonnetFirst` reached only 2 of 5 call sites, so `tomli` and `dnspython` stayed on Opus. The canary caught it. `tests/sonnet-first.test.ts` now covers the flag end to end.

## Vetoes

- `marked`, `tomli`, `dnspython`: no rejected run, so no veto. `tomli` repeat 2 did not run, because the budget stopped it.
- `sqlglot`: 0 of 1 is not a regression. That run was on Opus, and the routed baseline on Opus is 1 of 5. The second run hit the 15-minute limit set for this rerun, and earlier runs took about 13 minutes, so that row is no result.
- **The third rule fires as written on `dnspython` and `sqlglot`, which never left Opus.** The cause is not the flag. Both rate as critical, and T3 on critical work keeps Opus by design. On `sqlglot` the rating comes from `scope.expression.sql` matching a schema pattern, which looks like a false positive. That needs its own fix.

The rule took effect on `tomli` and `marked` repeat 2, where the need named Opus and the route was Sonnet. This canary does not test Sonnet on a hard task, so the ladder's move from Sonnet to Opus was not exercised live.

## Spend

The ledger shows $16.35 against a $6 cap, across the two runs and the timeout. The budget is checked only between runs, and the budget was raised to rerun. The pacing window then held the run for two hours, because it was set too low at $12.
