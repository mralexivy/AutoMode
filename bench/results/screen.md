Runs: 191 rows, 187 valid, 4 harness errors, 0 excluded for contamination, 0 stopped by a usage limit or setup, 0 with no reported cost. Tasks: 66. Cohorts: feature, longctx, migration, refactor, security, trivial.
All USD values are API list-price equivalents from the CLI, not subscription charges. Intervals are bootstrap 95% CIs that resample tasks, then repeats, stratified by cohort (2,000 resamples, seed 42). The unstratified columns drop the cohort strata. With few tasks per cohort the stratified interval runs narrow, so read both.

### By arm

| Arm | Runs | Accepted | Accepted, unstratified | Cost per accepted task | Cost, unstratified | Opus USD per accepted task | Median wall time | Runs with commits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Sonnet 5.5, fixed medium | 51 | 92% [82%–100%] | [78%–100%] | $0.23 [$0.15–$0.33] | [$0.14–$0.41] | $0.00 [$0.00–$0.00] | 44s | 0 |
| Sonnet 5.5, fixed high | 133 | 97% [93%–100%] | [92%–100%] | $0.30 [$0.25–$0.38] | [$0.25–$0.39] | $0.00 [$0.00–$0.00] | 76s | 0 |
| Opus 5.5, fixed medium | 3 | 100% [100%–100%] | [100%–100%] | $3.16 [$2.84–$3.37] | [$2.84–$3.37] | $3.16 [$2.84–$3.37] | 1295s | 0 |

### Accepted runs by cohort

| Cohort | sonnet-medium | sonnet-high | opus-medium |
|---|---:|---:|---:|
| feature | 24/24 | 60/60 | 0/0 |
| longctx | 3/6 | 27/29 | 3/3 |
| migration | 6/6 | 8/8 | 0/0 |
| refactor | 0/0 | 2/4 | 0/0 |
| security | 14/15 | 24/24 | 0/0 |
| trivial | 0/0 | 8/8 | 0/0 |

### Non-inferiority check (declared before the runs)

Rule: per cohort, an AutoMode arm accepts no fewer runs than the best baseline minus one, and in critical cohorts it accepts no fewer than the best baseline.


### Paired comparison against fixed arms

Each row is the AutoMode arm minus the fixed arm, on the tasks both ran. Cells with no label are stratified by cohort. p is the exact McNemar test on per-task majority verdicts, Holm-adjusted across the rows of one AutoMode arm.

| AutoMode arm | Fixed arm | Tasks | Solved | Solved, unstratified | Mean cost | Cost, unstratified | Mean wall time | Only fixed solved | Only AutoMode solved | p (Holm) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|

### Pareto frontiers

An arm is on a frontier when no other arm is as good on both measures and better on one.

- Solved rate and mean cost: sonnet-medium, sonnet-high, opus-medium
- Solved rate and mean wall time: sonnet-medium, sonnet-high, opus-medium

### Routing quality

Regret and these measures are relative to the arms that ran, so they say nothing about arms left out. A task counts as solved at a majority of its repeats. Lambda values are illustrative, not a recommended trade-off.

| AutoMode arm | Tasks | On the cost frontier | Median excess cost when solved | Failures another arm solved | Solved where a cheaper arm solved too | Mean regret (λ $0.1, 0) | (λ $0.5, 0) | (λ $0.1, 0.001/s) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|

### Stage cost for AutoMode arms (from the per-stage trace)

| Arm | Stage | Calls | Output tokens | Est. USD |
|---|---|---:|---:|---:|
