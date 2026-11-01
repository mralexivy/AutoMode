# Delegated reads canary, 2026-11-01

This run counts toward no claim. All costs are list-price equivalents.

| Check | Result |
|---|---|
| `delegate-eval.mts` | 10 of 10 cases, $0.46 |
| Canary runs accepted | 8 of 8, $1.63 |
| Median blind score | 4.80, 0 disputed |
| Gate events in the canary | 0 |
| Live forced `extract` call | 2 verified findings, $0.003 |

No veto fired, but the canary did not exercise the gate. The 8 runs made 2 full reads, and neither reached the 1.5k-token stress gate. The model worked through Bash and ranged reads. So this run shows no regression on these tasks. It says nothing about the read-again rate.

The eval's first run passed 9 of 10, because Haiku reported an absence as a finding. The prompt fix came before the final run. The pass rule did not change.

A refactor of `lib/io.ts` followed the canary. It moves host calls and changes no behavior. The canary did not run again, because a run that never reaches the gate adds nothing.

`delegation` therefore stays `off`. Turning it on by default needs real read-again data from `shadow`.
