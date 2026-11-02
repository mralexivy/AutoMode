# Canaries for the completion gate and the Sonnet executor

This file fixes the veto rules before any canary row exists. A canary can veto a default. It cannot prove equivalence or a saving, and it counts toward no claim. The tasks were picked to stress each change, so their cost says nothing about an average.

Nothing here weakens `PREREGISTERED.md`. These runs are probes, like `hard-probe`. They are not a screen retry and not a confirmation.

## Gate canary

`gate-canary.json` runs `gate-block` on `sqlglot`, 3 repeats. The baseline is the routed result, 1 of 5.

- 2 of 3 or better is encouraging. It is not proof.
- A run that loops, or a task with more than one block, is a defect in the gate.

## Executor canary

`executor-canary.json` runs `executor-sonnet` on 5 tasks, 3 repeats each. The baseline is fixed Sonnet high on the same tasks.

- A task that passes fewer repeats than its baseline vetoes `executor: sonnet` as a default.
- `security-toughcookie-secure-cookie-origin` must run at high, because its text rates as critical.

## Gate overhead

`completionGate: block` as a default needs a separate run on easy tasks. A rise of more than 15% in cost vetoes it. These canaries do not measure that.

## Delegated reads canary

`delegate-canary.json` runs `delegate-stress` on 4 cheap tasks, 2 repeats each. Spend is capped at $3. At the shipped gate, only 3 of 76 tasks ever hit a full read of 5k tokens or more, so a normal run would mostly measure nothing. The stress arm gates at 1.5k tokens on tasks with no risk rating. It therefore tests a harsher gate than the one that ships. The baseline is `auto` in `final-check.jsonl`, which passed all four tasks.

- A rejected run that a rerun does not clear vetoes the change.
- A read loop, or a stopped run that traces to the gate, is a defect.
- More than half of gated files read in full afterwards vetoes `delegation: on`, because the session pays twice.
- `delegate-eval.mts` must keep at least 8 of 10 cases, and no invented finding may survive on the absent case.

These rows count toward no claim, and they say nothing about cost.

## Opus rule canary

`opus-rule-canary.json` runs `auto` on 4 tasks the old rule sent to Opus, 2 repeats each. Spend is capped at $6. The baseline is the `auto` and `executor-sonnet` rows on the same tasks.

- On `marked`, `tomli` and `dnspython`, any rejected run vetoes the change.
- `sqlglot` is the one hard task. The routed baseline is 1 of 5 on Opus. If 0 of 2 pass and the ladder never reached Opus in either run, that vetoes the change.
- A run that never leaves Opus on these tasks means the rule did not take effect, and that is a defect.

These rows count toward no claim. They can show a drop in Opus use on these tasks, and they prove no general saving.

## Classification check

`classification-check.json` runs `auto` with fixed `sonnet-high` and `opus-medium` on the same 7 tasks, 3 repeats each. The tasks are ones the router sent to Opus at least once. `sqlglot` is the hard task. Hidden tests are the primary result. A timeout or a failed setup is no result.

Each of these is a defect to fix before a release:

- **Lost quality.** `auto` passes 2 or more fewer runs than `opus-medium` in total.
- **Under-routing.** On a task where `sonnet-high` fails at least 2 of 3, `auto` runs on Sonnet in 2 or more repeats.
- **Over-routing.** On 3 or more tasks, `auto` runs on Opus in 2 or more repeats, while `sonnet-high` passes 3 of 3 at no more than half the cost of `auto`.
- **No value.** `auto` costs more per task than `opus-medium`, on the mean.

7 tasks make this a pilot. It finds defects and shows a direction. It proves no general saving.

## Classification canary

`classify-canary.json` runs `auto` on the final code, on 9 tasks outside the 11 used to find the defect, plus `sqlglot`, 1 repeat each. Spend is capped at $6.

- A rejected run on a task Sonnet high passes is a defect, unless a rerun clears it.
- If `auto` runs Haiku on fewer than half of the tasks, the fix did not take effect.
- `sqlglot` must start on Opus.

A pass allows a release. It proves no general saving.

## What a pass allows

A pass permits wider opt-in use and shadow collection. Changing a default needs new tasks with real outcome data, and it is a separate decision.
