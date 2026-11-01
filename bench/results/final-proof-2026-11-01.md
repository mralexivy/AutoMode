# AutoMode routing: final results

Date: 2026-11-01. All costs are API list-price equivalents, not plan charges. Plan: Claude Max 5x.

**This is a pilot. It makes no saving claim.** The confirmation run did not happen, because the stop rule fired.

## Outcome of the pre-registered study

The rule in `bench/experiments/PREREGISTERED.md` needed at least 8 hard tasks. The screen found 1. The confirmation did not run. The stop rule's result applies: Sonnet was enough on every real task we found, with the one exception below.

| Screen label | Tasks |
|---|---:|
| Hard | 1 |
| Easy, picked | 15 |
| Neither | 1 |
| Passed Sonnet high twice, Sonnet medium not run | 48 |
| Excluded: broken fixture | 1 |

The screen used 187 valid runs and cost $59.35. Step 1 used 132 runs, step 2 used 7, and step 3 used 48. `refactor-pymarkdown-block-level-v2` fails its accept command at its own reference commit, so it is no result. Excluding it can only lower the hard count. Four runs on two immer tasks hit a harness fault, fixed in #63, and ran again. The rerun rows carry a later harness SHA, and that change touches `bench/` only.

Fixed arms across the screen: Sonnet high passed 129 of 131 runs on valid tasks. Sonnet medium passed 47 of 51 runs. On the 17 tasks both arms ran, Sonnet medium averaged $0.21 and Sonnet high averaged $0.29.

## The one hard task

`longctx-sqlglot-intersect-precedence-across-dialects`:

| Arm | Passed | Average cost |
|---|---:|---:|
| Sonnet medium | 0/3 | $0.99 |
| Sonnet high | 1/3 | $1.42 |
| Opus medium | 3/3 | $3.16 |
| AutoMode, from both starts (exploratory) | 1/5 | $3.27 |

AutoMode chose Opus in all five runs, so the route was right. It still passed fewer runs than plain Opus medium. The gap is not significant (Fisher exact, two-sided p = 0.14), and its cause is unknown. A sixth run was lost when the process was stopped from outside. This probe counts toward no claim.

## Start from Opus, live

12 tasks, one run each, on final routing code (`bench/results/final-check.jsonl`):

| | Sonnet start | Opus start |
|---|---:|---:|
| Accepted | 12/12 | 12/12 |
| Opus requests, of all requests | 92 of 179 | 25 of 156 |
| Cost | $5.13 | $5.79 |

The two starts picked different models on 4 of 12 tasks. The Sonnet start picked Opus on 5 tasks that Sonnet solves. Issue #47 stays open.

## Mid-session switching

One task, three prompts, three repeats, all accepted (`bench/results/session-switch-final.jsonl`):

| Arm | Models by prompt | Session cost | Follow-up cost |
|---|---|---:|---:|
| Stay on Opus high | Opus, Opus, Opus | $1.66 | $0.13 |
| Naive switch | Opus, Sonnet, Sonnet | $1.83 | $0.27 |
| Opus, lower effort | Opus, Opus, Opus | $1.55 | $0.12 |
| AutoMode from Opus | Sonnet, Sonnet, Sonnet or Haiku | $0.36 | $0.04 |

AutoMode left Opus at the first prompt. The naive switch costs more than staying, because it pays to rebuild the cache.

## Effort judge against effortless

75 upstream labeled cases, three passes each. Upstream scored 95.1% and AutoMode scored 96.0%. The difference is +0.9 points, 95% CI −4.0 to +4.9. This is a tie. AutoMode gave an answer every time, where upstream gave none 8 times. Neither arm ever set effort too low. No live run compared the two plugins.

## Other results

- The workflow cost about 2.1 to 2.7 times Opus and showed no measured gain. Automatic entry is off.
- Three benchmark processes were stopped by an outside SIGTERM. The source is unknown. Two stops lost no rows, and one lost the sixth probe run.

## What this does and does not show

Shown: a session that starts on Opus now moves to Sonnet when the task allows, and it passes the same tests.

Not shown: that AutoMode beats effortless, that it solves more than Sonnet high, or any general saving.
