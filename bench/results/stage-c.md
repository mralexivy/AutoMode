Runs: 144 rows, 144 valid, 0 harness errors, 0 excluded for contamination, 0 stopped by a usage limit or setup, 0 with no reported cost. Tasks: 12. Cohorts: feature, longctx, migration, refactor, security, trivial.
**Pilot: 12 tasks. This is too few to support a claim, and intervals may be wide or optimistic.**
All USD values are API list-price equivalents from the CLI, not subscription charges. Intervals are bootstrap 95% CIs that resample tasks, then repeats, stratified by cohort (2,000 resamples, seed 42).

### By arm

| Arm | Runs | Accepted | Cost per accepted task | Opus USD per accepted task | Median wall time | Runs with commits |
|---|---:|---:|---:|---:|---:|---:|
| Sonnet 5.5, fixed medium | 36 | 100% [100%–100%] | $0.15 [$0.14–$0.17] | $0.00 [$0.00–$0.00] | 49s | 0 |
| Sonnet 5.5, fixed high | 36 | 100% [100%–100%] | $0.21 [$0.19–$0.23] | $0.00 [$0.00–$0.00] | 58s | 0 |
| Opus 5.5, fixed high | 36 | 100% [100%–100%] | $0.96 [$0.86–$1.07] | $0.96 [$0.86–$1.06] | 199s | 0 |
| AutoMode Auto: model and effort routing | 36 | 100% [100%–100%] | $0.44 [$0.30–$0.58] | $0.32 [$0.13–$0.49] | 95s | 0 |

### Accepted runs by cohort

| Cohort | sonnet-medium | sonnet-high | opus-high | auto |
|---|---:|---:|---:|---:|
| feature | 6/6 | 6/6 | 6/6 | 6/6 |
| longctx | 6/6 | 6/6 | 6/6 | 6/6 |
| migration | 6/6 | 6/6 | 6/6 | 6/6 |
| refactor | 6/6 | 6/6 | 6/6 | 6/6 |
| security | 6/6 | 6/6 | 6/6 | 6/6 |
| trivial | 6/6 | 6/6 | 6/6 | 6/6 |

### Non-inferiority check (declared before the runs)

Rule: per cohort, an AutoMode arm accepts no fewer runs than the best baseline minus one, and in critical cohorts it accepts no fewer than the best baseline.

- **AutoMode Auto: model and effort routing:** passes

### Paired comparison against fixed arms

Each row is the AutoMode arm minus the fixed arm, on the tasks both ran. p is the exact McNemar test on per-task majority verdicts, Holm-adjusted across the rows of one AutoMode arm.

| AutoMode arm | Fixed arm | Tasks | Solved | Mean cost | Mean wall time | Only fixed solved | Only AutoMode solved | p (Holm) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| AutoMode Auto: model and effort routing | Sonnet 5.5, fixed medium | 12 | 0 pts [0 pts–0 pts] | +$0.29 [+$0.17–+$0.42] | +68s [+39s–+96s] | 0 | 0 | 1.000 |
| AutoMode Auto: model and effort routing | Sonnet 5.5, fixed high | 12 | 0 pts [0 pts–0 pts] | +$0.23 [+$0.11–+$0.35] | +53s [+30s–+78s] | 0 | 0 | 1.000 |
| AutoMode Auto: model and effort routing | Opus 5.5, fixed high | 12 | 0 pts [0 pts–0 pts] | -$0.52 [-$0.63–-$0.41] | -99s [-127s–-70s] | 0 | 0 | 1.000 |

### Pareto frontiers

An arm is on a frontier when no other arm is as good on both measures and better on one.

- Solved rate and mean cost: sonnet-medium
- Solved rate and mean wall time: sonnet-medium

### Routing quality

Regret and these measures are relative to the arms that ran, so they say nothing about arms left out. A task counts as solved at a majority of its repeats. Lambda values are illustrative, not a recommended trade-off.

| AutoMode arm | Tasks | On the cost frontier | Median excess cost when solved | Failures another arm solved | Solved where a cheaper arm solved too | Mean regret (λ $0.1, 0) | (λ $0.5, 0) | (λ $0.1, 0.001/s) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| AutoMode Auto: model and effort routing | 12 | 8% | $0.07 | 0/0 | 11/12 | 0.029 | 0.145 | 0.097 |

### Stage cost for AutoMode arms (from the per-stage trace)

| Arm | Stage | Calls | Output tokens | Est. USD |
|---|---|---:|---:|---:|
| AutoMode Auto: model and effort routing | main | 466 | 270,906 | $13.20 |
| AutoMode Auto: model and effort routing | unknown | 43 | 32,010 | $1.37 |
| AutoMode Auto: model and effort routing | Discover | 15 | 14,782 | $0.01 |
| AutoMode Auto: model and effort routing | Review | 4 | 6,995 | $0.26 |
| AutoMode Auto: model and effort routing | Verify | 7 | 3,138 | $0.08 |
| AutoMode Auto: model and effort routing | Build | 17 | 16,331 | $0.32 |
| AutoMode Auto: model and effort routing | Plan | 8 | 21,412 | $0.63 |
