# Classification results, 2026-11-02

These runs count toward no claim. All costs are list-price equivalents. Hidden tests are the only quality measure here, so code quality beyond them is unmeasured.

## What was wrong

`bench/classify-eval.mts` asked the real judges about real prompts, through the real rules.

| Should pick | Before |
|---|---:|
| Opus (`sqlglot`) | 5 of 5 |
| Sonnet | 29 of 30 |
| Haiku | 0 of 20 |

Both judges rate small work as T1 and Sonnet, and Haiku needed T0 and a Haiku verdict, so it never ran. One live `sqlglot` run came back T2 with need=opus, which fell to Sonnet because the Opus rule needed T3.

## How strong each model is

`haiku-screen.jsonl`: fixed Haiku on all 65 screen tasks, one run each.

| Model | Passed | Average cost |
|---|---:|---:|
| Haiku | 64 of 65 | $0.036 |

`sqlglot` was the one failure. Sonnet high passed 129 of 131 runs on the same set at about $0.29, so this set does not separate the models well. Earlier runs of `sqlglot` show it needs Opus more often than not.

## The fix

T0 to T2 work without critical risk can run on Haiku, unless the need names Opus. T2 with need=opus now requires Opus. T3 stays on Sonnet or Opus. After the fix, the judge test sends the trivial tasks to Haiku 12 of 12 times.

## Live canary

`classify-canary.jsonl`: 10 tasks, 9 of them outside the tuning set, one run each, $6.66.

| Result | Value |
|---|---:|
| Accepted, excluding `sqlglot` | 9 of 9 |
| `sqlglot` | Started on Opus, rejected, $3.44 |
| Ran on Haiku | 3 of 10 |
| Ran on Sonnet | 4 of 10 |
| Ran on Opus | 3 of 10 |

**One rule was missed.** `CANARIES.md` asked for Haiku on at least half of the tasks, and it ran on 3 of 10. Every T1 or T2 task without critical risk did reach Haiku, so the flag works. The judges rated the other tasks T3 or critical. The rule was a guess at that mix. It stands as written, and this report records the miss.

**Open points.**

- The judges are noisy on `sqlglot`: 2 of 3 Opus after the fix, and a verdict of need=sonnet in other runs.
- `sqlglot` failed on Opus here too, with no escalation, because no check failed before the model stopped.
- One Haiku run cost $0.98, about 30 times the Haiku average.

## Other stopped runs

`classification-check.jsonl` was stopped at 29 of 63 runs once the misroute was clear. It stays partial.
