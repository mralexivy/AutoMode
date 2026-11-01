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

## What a pass allows

A pass permits wider opt-in use and shadow collection. Changing a default needs new tasks with real outcome data, and it is a separate decision.
