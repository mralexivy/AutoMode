Runs: 25 rows, 25 valid, 0 harness errors, 0 excluded for contamination, 0 stopped by a usage limit or setup, 0 with no reported cost. Tasks: 5. Cohorts: feature, longctx, security.
**Pilot: 5 tasks. This is too few to support a claim, and intervals may be wide or optimistic.**
All USD values are API list-price equivalents from the CLI, not subscription charges. Intervals are bootstrap 95% CIs that resample tasks, then repeats, stratified by cohort (2,000 resamples, seed 42). The unstratified columns drop the cohort strata. With few tasks per cohort the stratified interval runs narrow, so read both.

### By arm

| Arm | Runs | Accepted | Accepted, unstratified | Cost per accepted task | Cost, unstratified | Opus USD per accepted task | Median wall time | Runs with commits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Sonnet 5.5, fixed medium | 15 | 100% [100%–100%] | [100%–100%] | $0.21 [$0.20–$0.22] | [$0.14–$0.32] | $0.00 [$0.00–$0.00] | 66s | 0 |
| Sonnet 5.5, fixed high | 10 | 100% [100%–100%] | [100%–100%] | $0.33 [$0.31–$0.34] | [$0.23–$0.52] | $0.00 [$0.00–$0.00] | 105s | 0 |

### Accepted runs by cohort

| Cohort | sonnet-medium | sonnet-high |
|---|---:|---:|
| feature | 6/6 | 4/4 |
| longctx | 3/3 | 2/2 |
| security | 6/6 | 4/4 |

### Non-inferiority check (declared before the runs)

Rule: per cohort, an AutoMode arm accepts no fewer runs than the best baseline minus one, and in critical cohorts it accepts no fewer than the best baseline.


### Paired comparison against fixed arms

Each row is the AutoMode arm minus the fixed arm, on the tasks both ran. Cells with no label are stratified by cohort. p is the exact McNemar test on per-task majority verdicts, Holm-adjusted across the rows of one AutoMode arm.

| AutoMode arm | Fixed arm | Tasks | Solved | Solved, unstratified | Mean cost | Cost, unstratified | Mean wall time | Only fixed solved | Only AutoMode solved | p (Holm) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|

### Pareto frontiers

An arm is on a frontier when no other arm is as good on both measures and better on one.

- Solved rate and mean cost: sonnet-medium
- Solved rate and mean wall time: sonnet-medium

### Routing quality

Regret and these measures are relative to the arms that ran, so they say nothing about arms left out. A task counts as solved at a majority of its repeats. Lambda values are illustrative, not a recommended trade-off.

| AutoMode arm | Tasks | On the cost frontier | Median excess cost when solved | Failures another arm solved | Solved where a cheaper arm solved too | Mean regret (λ $0.1, 0) | (λ $0.5, 0) | (λ $0.1, 0.001/s) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|

### Stage cost for AutoMode arms (from the per-stage trace)

| Arm | Stage | Calls | Output tokens | Est. USD |
|---|---|---:|---:|---:|

### Outcome matrix

A cell is one task and one arm under one experiment identity: model, policy, spec hash, environment, grader and harness SHA. Repeats share a cell. Two identities are never pooled: they are a conflict, and the signals read the larger cell. A cell that never ran is missing, not zero. Intervals here are exact Clopper-Pearson 95% intervals over one cell's repeats.

- Observations: 25 graded runs. Rows left out (no result, contaminated or ungraded): 0.
- Cells: 5 tasks × 2 arms = 10. Run: 10. Conflicts: 0. Missing: 0.

### Benchmark health signals

Three separate signals. They are never combined into one score.

- **Difficulty:** the pass rate of the reference arm `sonnet-high`. Mean over 5 tasks, each weighted once: 100% [100%–100%] (bootstrap over tasks). Tasks it fails by majority: 0.
- **Outcome discrimination:** a task discriminates when the per-task majority verdicts of its arms differ. A verdict is solved when more than half the repeats pass, and a tie is not solved, as in stats.mts `discordant`. 0 of 5 tasks that ran on two or more arms discriminate (0%). Tasks on one arm only: 0.
- **Economic discrimination:** two arms with the same majority verdict differ when one costs at least 1.5× the other per accepted run. 3 of 5 tasks with such a pair discriminate (60%).

| Arm A | Arm B | Shared tasks | Only A solved | Only B solved | p (McNemar, Holm) |
|---|---|---:|---:|---:|---:|
| sonnet-high | sonnet-medium | 5 | 0 | 0 | 1.000 |

**`longctx-sqlglot-intersect-precedence-across-dialects`:**
- Not in these results.

> **Warning (heuristic, not a release gate).** Only 0 of 5 comparable tasks (0%) separate the arms on outcome, below 20%. The set may be too easy or too hard to rank arms.

### False completion rate

Rate = runs that explicitly claimed completion and failed acceptance ÷ runs that explicitly claimed completion and have a valid grade. The claim field is `completion.claimed`, a boolean. A row without it is N/A, never a success or a failure.

- Rate: 0/25 (0%).
- N/A: 0 of 25 rows. No claim field: 0. Ambiguous field: 0. Claim without a valid grade: 0. Explicitly no claim: 0.
- Completion gate: no graded run with a gate verdict of verified.
