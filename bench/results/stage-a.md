Runs: 3 rows, 3 valid, 0 harness errors, 0 excluded for contamination, 0 stopped by a usage limit or setup, 0 with no reported cost. Tasks: 1. Cohorts: trivial.
**Pilot: 1 tasks. This is too few to support a claim, and intervals may be wide or optimistic.**
All USD values are API list-price equivalents from the CLI, not subscription charges. Intervals are bootstrap 95% CIs that resample tasks, then repeats, stratified by cohort (2,000 resamples, seed 42).

### By arm

| Arm | Runs | Accepted | Cost per accepted task | Opus USD per accepted task | Median wall time | Runs with commits |
|---|---:|---:|---:|---:|---:|---:|
| Sonnet 5.5, fixed high | 1 | 100% [100%–100%] | $0.10 [$0.10–$0.10] | $0.00 [$0.00–$0.00] | 25s | 0 |
| Opus 5.5, fixed high | 1 | 100% [100%–100%] | $0.43 [$0.43–$0.43] | $0.43 [$0.43–$0.43] | 68s | 0 |
| AutoMode Auto: model and effort routing | 1 | 100% [100%–100%] | $0.12 [$0.12–$0.12] | $0.00 [$0.00–$0.00] | 32s | 0 |

### Accepted runs by cohort

| Cohort | sonnet-high | opus-high | auto |
|---|---:|---:|---:|
| trivial | 1/1 | 1/1 | 1/1 |

### Non-inferiority check (declared before the runs)

Rule: per cohort, an AutoMode arm accepts no fewer runs than the best baseline minus one, and in critical cohorts it accepts no fewer than the best baseline.

- **AutoMode Auto: model and effort routing:** passes

### Paired comparison against fixed arms

Each row is the AutoMode arm minus the fixed arm, on the tasks both ran. p is the exact McNemar test on per-task majority verdicts, Holm-adjusted across the rows of one AutoMode arm.

| AutoMode arm | Fixed arm | Tasks | Solved | Mean cost | Mean wall time | Only fixed solved | Only AutoMode solved | p (Holm) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| AutoMode Auto: model and effort routing | Sonnet 5.5, fixed high | 1 | 0 pts [0 pts–0 pts] | +$0.01 [+$0.01–+$0.01] | +7s [+7s–+7s] | 0 | 0 | 1.000 |
| AutoMode Auto: model and effort routing | Opus 5.5, fixed high | 1 | 0 pts [0 pts–0 pts] | -$0.31 [-$0.31–-$0.31] | -36s [-36s–-36s] | 0 | 0 | 1.000 |

### Pareto frontiers

An arm is on a frontier when no other arm is as good on both measures and better on one.

- Solved rate and mean cost: sonnet-high
- Solved rate and mean wall time: sonnet-high

### Routing quality

Regret and these measures are relative to the arms that ran, so they say nothing about arms left out. A task counts as solved at a majority of its repeats. Lambda values are illustrative, not a recommended trade-off.

| AutoMode arm | Tasks | On the cost frontier | Median excess cost when solved | Failures another arm solved | Solved where a cheaper arm solved too | Mean regret (λ $0.1, 0) | (λ $0.5, 0) | (λ $0.1, 0.001/s) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| AutoMode Auto: model and effort routing | 1 | 0% | $0.01 | 0/0 | 1/1 | 0.001 | 0.005 | 0.008 |

### Blind quality scores (secondary)

Hidden tests are the primary result. Scores are the mean of five rubric items from 1 to 5, and only runs the judges agree on count.

| Arm | Graded | Disputed | Median score |
|---|---:|---:|---:|
| Sonnet 5.5, fixed high | 1 | 0 | 4.00 |
| Opus 5.5, fixed high | 1 | 0 | 4.80 |
| AutoMode Auto: model and effort routing | 1 | 0 | 4.20 |

### Stage cost for AutoMode arms (from the per-stage trace)

| Arm | Stage | Calls | Output tokens | Est. USD |
|---|---|---:|---:|---:|
| AutoMode Auto: model and effort routing | main | 9 | 2,989 | $0.12 |
