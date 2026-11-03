# Benchmark architecture

A paid run must always end in a valid answer. Work whose saved evidence can answer a question is never paid for twice. This file sets out how. [BENCHMARK_RUNBOOK.md](BENCHMARK_RUNBOOK.md) has the commands.

## Stages

Each stage reads the artifacts of the stage before it, and each can run again on its own. Only stage 5 calls a model.

| # | Stage | Command | Reads | Writes | Model calls |
|---|---|---|---|---|---|
| 1 | Fixture validation | `preflight.mts` (`fixtures`) | task file, its repository | `results/preflight/fixtures/<task>.json` | 0 |
| 2 | Trace replay | `preflight.mts` (`history`), `reuse-audit.mts` | saved transcripts, plugin records | the report | 0 |
| 3 | Harness simulation | `npm test` (`orchestration.test.mts`, `run.test.mts`) | the fake `claude` | none | 0 |
| 4 | Frozen plan | `preflight.mts` | experiment, tasks, arms, code | `results/preflight/<id>.json`, with the plan hash | 0 |
| 5 | Paid execution | `run.mts` or `supervise.mts` | the plan, the gate, the lock | rows, diffs, `<id>.events.jsonl`, `<id>.status.json` | yes |
| 6 | Offline grading | `regrade.mts` | rows, diffs, task | `<id>.grades-v<N>.jsonl` | 0 |
| 7 | Offline analysis | `decide.mts`, `status.mts` | rows or grades, policy | `decision.json` | 0 |

## Identities

A row's run id is `<task>__<arm>__r<rep>__<execution key>`. The key hashes identity v2 ([`lib/identity.mts`](lib/identity.mts)), and the row also stores the parts in its `identity` block. A plan can then say which part made an old row stale.

| Part | What it covers | Changes when |
|---|---|---|
| `task` | base, reference, task text, accept, hidden tests, **setup**, lint, typecheck, regression, limits, requirements | a fixture is fixed: pymarkdown-v2's Pygments pin now retires its old rows |
| `arm` | model, effort, env, plugin config | an arm is redefined |
| `code` | hashes of the **behavior files** only: `hooks/`, `agents/`, `commands/`, `output-styles/`, `workflows/`, `config.json`, `plugin.json` without its version. `null` for arms that load no plugin | shipped code changes. The changelog, docs, tests, bench code and a version bump do not |
| `template` | the prompt template's sha256 | the prompt changes |
| `agentEnv` | `AGENT_ENV_VERSION`: what the harness gives the agent (version 3: every path the accept command sets) | the agent's environment changes |
| `rep` | the repetition | never: a repetition is its own run, not a duplicate |

The other keys:

- **Evidence key.** The run id itself, which names the saved transcript (`~/.claude/projects/...`), the diff (`results/diffs/<run_id>.diff`) and the plugin records.
- **Grading key.** Hashes the run id, the diff, `GRADER_VERSION`, the accept command and the hidden tests. A grade with the same key is not repeated.
- **Analysis.** The rows or grades, plus the policy file. A policy has its own id and never changes after a row exists.

## Invalidation matrix

| Change | Rows that rerun (paid) | Rows that are kept | Free work instead |
|---|---|---|---|
| Docs, changelog, tests, bench code, version bump | none | all | none |
| Grader or accept logic (`GRADER_VERSION`) | none | all | `regrade.mts` from the diffs |
| Decision policy or report | none | all | `decide.mts` with the new policy id |
| Classifier or replay code that only reads | none, unless it acted during the run | all | `reuse-audit.mts` and the history replay |
| Ladder-only modules (`LADDER_SCOPE`: `rescue.ts`, `handoff.ts`, `bands.ts`) | rows that escalated, and rows the new code would escalate on replay | rows with no ladder action recorded **and** none replayed (`replay-equivalent`) | `reuse-audit.mts --changed ...` |
| Any other behavior file (`v4.ts`, `failures.ts`, `config.json`...) | every row of arms that load the plugin | arms that load no plugin (`code: null`) | none |
| Fixture or setup (`task`) | that task's rows | other tasks | none |
| Agent environment (`agentEnv`) | every row | none | none |
| An interrupted or `UNKNOWN` run | that slot, only with `--retry-unknown` | the partial evidence, for diagnosis | none |

Reuse never rests on a filename or a commit that looks alike. `--reuse-from` copies a row only when the run id matches exactly, and it marks the row `reused_from`. A stale row is reported with the parts that differ (`classify` in [`lib/plan.mts`](lib/plan.mts)).

`failures.ts` is outside `LADDER_SCOPE` on purpose: it also rewrites check commands (`withPipefail`), and the agent sees those.

## The run ledger and its honest states

`<id>.events.jsonl` is append-only. Each line is written and synced before the runner moves on. The states:

```
RUNNING ──► COMPLETED   row written and synced first, then this event
        ├─► QUOTA_PAUSED  usage limit: no new run starts; reset time saved if the CLI stated one
        ├─► INVALID       setup failed or the harness broke: no new run starts (integrity stop, exit 4)
        └─► (owner dies)  folds to UNKNOWN
```

- **COMPLETED.** A row in the results file is the proof. A crash between the row and its event still counts as finished.
- **UNKNOWN.** The provider may have started and billed the run, and no durable result exists. It never reruns on its own: `--retry-unknown` authorizes it. Its partial transcript stays for diagnosis.
- **Not promised:** that a remote run happened exactly once, or that a run killed mid-flight lost nothing. The ledger records what is known, no more.

## Locks, admission and quota

- **Lock.** `~/.automode-bench/paid.lock` is created with `O_EXCL`. It holds the owner's pid, host and experiment, and a heartbeat every 30 seconds. A second runner exits 3. A lock whose owner is dead, or whose heartbeat is 5 minutes old, is taken over, and the takeover is logged.
- **Admission.** A run starts only if *spent + expected cost in flight + expected cost of this run ≤ budget*. Expected cost comes from saved rows, in this order: the same task and arm, the task on any arm, the arm, every row, the run cap. These are list-price estimates. They are no billing stop, and no proxy for the plan's 5-hour window.
- **Quota.** The first usage-limit row stops all admissions. The runner writes `QUOTA_PAUSED` and the `reset_at` the CLI stated, if any, then exits 75. Runs already in flight finish.
- **Parallel runs.** The default is 1.

## Supervision

`supervise.mts` reruns the runner after a stated reset, plus 3 minutes. With no stated reset, a reset more than 6 hours away, or any other exit (gate 2, lock 3, integrity 4), it stops. It never guesses a time and never retries in a loop. To survive a closed terminal or a job cap, it runs under the OS service manager: `launchctl submit` on macOS, `systemd-run --user` on Linux. `nohup` alone did not survive the 2-hour job cap, because the cap kills the process group.

## Accounting

| Field | Meaning |
|---|---|
| `cost_usd_api_equiv` | The CLI's list-price-equivalent total for the run. With `auth: subscription` this is **not billed money**: it is what the run would cost on the API. |
| Plan usage | The 5-hour and weekly windows. Separate, and unpublished. `--window-usd` paces by list spend in the ledger, and the CLI's limit message is the only hard signal. |
| Cost per accepted | **Every paid attempt** of an arm (cut off, invalid and failed included) divided by its accepted tasks. |
| Waste | The spend of rows that are no result, plus rows the plan no longer uses (`status.mts` `wasted_list_usd`). Each row is counted in one category only. |

## Risk limits

| Limit | Value |
|---|---|
| Paid experiments at a time | one, machine-wide |
| Default parallel runs | 1 |
| Spend per run | `run_cap_usd`, passed to `claude --max-budget-usd` |
| Spend per experiment | `budget_usd`, enforced at admission |
| Preflight age | a report older than 24 hours blocks |
| After a defect | a plan that changes in any way needs a new preflight; an integrity defect mid-run stops admissions |
| Decision policy | fixed before any row; a change is a new policy id |
