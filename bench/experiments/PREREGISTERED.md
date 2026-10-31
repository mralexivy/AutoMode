# Pre-registered selection and decision rules

This file fixes the rules before any candidate task runs. Thresholds cannot change after results exist. Commit this file, and freeze the candidate tasks at a tagged SHA, before the first screen run.

Nothing in this file weakens a rule in [`bench/README.md`](../README.md). Where the two differ, the stricter rule applies.

## The question

Does AutoMode pick the model from the task? "Beat" has two meanings, because a router that buys Opus on hard tasks cannot be cheaper than Sonnet high and also solve more:

- Against Sonnet high, AutoMode wins on quality within a cost ceiling.
- Against Opus medium, AutoMode wins on cost with quality held.

## Step 1: the task screen

`bench/experiments/screen.json` runs the candidate tasks on three fixed arms: `sonnet-medium`, `sonnet-high` and `opus-medium`. Each task runs 3 times per arm.

- The screen never includes an AutoMode arm.
- Screen rows never count toward a claim.
- A task counts as solved in a run only when the row has `accepted: true`.
- A usage limit, a failed setup or a test command that never returns is no result. Rerun it. It is not a pass and not a failure.
- A row that hits `run_cap_usd` still counts, with the verdict its hidden tests gave.
- A stop at `budget_usd` is no result. A task labels only after all its runs finish.
- The screen holds each task in one version. A `-v2` task replaces its first version.

### Run order

The screen skips only runs that cannot change a label. This order was fixed before any screen row existed. The labels stay the same as with the full matrix.

1. Run `sonnet-high` twice on every task. Two passes rule out the hard label, because hard needs at least 2 failures of 3.
2. A task with at least one failure runs `sonnet-high` a third time, then `opus-medium` and `sonnet-medium` 3 times each.
3. Tasks that passed step 1 are easy candidates. Sort them by the SHA-256 of the task id, ascending. Run `sonnet-medium` 3 times each, in that order, until 15 easy tasks are picked under the rule below. Later tasks stay unrun and count as not screened.

The report states how many runs each step used, and how many tasks stayed unrun.

## Step 2: the selection rule

Label each candidate from its screen rows:

- **Hard:** Sonnet high fails at least 2 of 3, and Opus medium passes at least 2 of 3.
- **Easy:** Sonnet medium passes 3 of 3.
- **Neither:** every other task. A task that meets both tests also counts as neither, because its arms disagree in a way that points to noise.

A task label comes only from the screen. A cohort, the size of the reference change or a guess never sets it.

Pick up to 15 tasks of each label:

1. Sort the tasks of one label by the SHA-256 of the task id, ascending.
2. Walk the list. Skip a task when its repository already has 3 picked tasks across both labels.
3. Stop at 15. With fewer than 15, take them all. One label never borrows from the other.

The size of a task's gap between arms plays no part in the pick. The report states how many candidates ran, how many were hard, easy and neither, and how many were skipped.

## Step 3: the stop rule

**Stop if there are fewer than 8 hard tasks.** Do not run the confirmation. The honest result is then: "Sonnet was enough on every real task we found."

A retry needs new tasks. Rerunning the screen on the same tasks to reach 8 is not allowed.

## Step 4: confirm once

Commit the picked task list first. Then run the confirmation once.

- Arms: `auto-from-opus` (primary), `sonnet-high`, `opus-medium`, `sonnet-medium`.
- 30 tasks × 4 arms × 3 repeats = 360 runs, plus `auto` for one repeat, 30 runs.
- `budget_usd` 340, `run_cap_usd` 6 for every arm, `window_usd` 90.
- Results go to a new file. A resume reads only its own results file, so no screen row can enter.

Haiku and Opus low are not part of this claim. The Opus-to-Sonnet mid-session track stays separate.

## The decision rule

**All must pass.**

- **A.** Easy stratum: cost per accepted against Opus medium, CI upper bound ≤ 0.60.
- **B.** Hard stratum: exact McNemar against Sonnet high, p < .025, AutoMode ahead. That needs at least 7:0 or 9:1.
- **C.** Easy stratum: cost per accepted against Sonnet high, CI upper bound ≤ 1.5.
- **D.** All tasks: acceptance against Opus medium, CI lower bound ≥ −15 points.
- **E.** The `bench/report.mts` cohort rule (the "Non-inferiority check" section) passes, and no fixed arm dominates AutoMode.

Gates A and C are ratios, AutoMode over the fixed arm. Gate D is AutoMode minus Opus medium. Each interval resamples tasks, then repeats, as `bench/lib/stats.mts` does. The report shows stratified and unstratified intervals. A gate uses the wider of the two. McNemar uses `mcnemarExact` on per-task majority verdicts, unadjusted.

"Dominates" means a fixed arm is at least as good as AutoMode on solved rate and mean cost, and strictly better on one.

## What counts as failure

- Any gate missing means no claim.
- B fails: Sonnet is the default.
- A or C fails: the router over-routes.
- Thresholds stay unchanged, and there are no reruns. A retry needs new tasks.
- Mixed SHAs or cap hits above 5% in any arm invalidate the run.

Report each gate separately, passed or failed.

## Limits of this design

- Selecting on screen outcomes inflates the Opus gap. Report how many candidates separated.
- The 15/15 mix is not a real mix of work. Never headline a blended saving.
- Plan usage is not list price.
- Sonnet may fail too rarely for B to be reachable.
- Claude Code or a model may drift during the run.
- Simulated power is low: with assumed rates (Sonnet high .3, Opus medium .85 on hard tasks), a router with a .9 hit rate on hard tasks passes gates A to D in 30% of trials. No-skill, always-Opus, always-Sonnet-medium and no-separation routers passed 0 of 200. So 30 tasks can falsify the design, but a real winner will often fail the joint test. These are simulations, not results.
