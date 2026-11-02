# The AutoMode benchmark

This folder measures AutoMode and compares models. It has three tracks, and their numbers never mix.

| Track | Question | Runner | Experiment files |
|---|---|---|---|
| `automode-system` | Does AutoMode beat plain Claude Code? | `claude -p` | `light`, `effort`, `auto`, `stage-a`, `stage-b`, `stage-c`, `stage-c-fixed`, `stage-agents`, `screen` |
| `neutral-model` | How good is a model under one shared scaffold? | Neutral agent in Docker | `frontier-core` |
| `claude-compatible` | Does another vendor's model work inside Claude Code? | `claude -p` through a gateway | `claude-compatible` |

Hidden tests are the primary result. Judge scores are secondary. A report never collapses quality, cost and time into one score.

## Run the AutoMode study

```bash
node bench/run.mts --experiment stage-a --dry-run
node bench/run.mts --experiment stage-a --out bench/results/stage-a.jsonl
node bench/grade.mts bench/results/stage-a.jsonl --budget-usd 2
node bench/report.mts --manifest bench/results/stage-a.manifest.json bench/results/stage-a.jsonl
```

Runs use your signed-in plan. An API key in your shell does not reach them, unless you set `BENCH_AUTH=api`. All costs are list-price equivalents, not charges.

**The usage window.** `--window-usd` caps list-price-equivalent spend per rolling 5 hours, from the ledger. It starts at $10, which is a cautious guess because plans publish no number. Tune it from Stage A. A full window waits. `--stop-at-window` ends the run instead. A usage limit waits, then retries the same run. Stopping is always safe: run the same command, and it continues.

**Confirm first.** The usage-limit pattern in `lib/outcome.mts` has not met a real limit message. The first real limit should print `USAGE LIMIT, will rerun`. If it prints `rejected`, fix the pattern before you trust the run.

## Plan usage

`--window-usd` is list-price spend, not plan usage. The real signal is in `claude -p --output-format stream-json --verbose`: a `rate_limit_event` holds `rate_limit_info.unifiedWindows.five_hour.utilization` and `seven_day.utilization`. On Max 5x, about $33 of list spend was 18% of the five-hour window and 6% of the week. A watcher on that signal is safer than a low `--window-usd`.

## Results so far

Stage C ran 12 tasks, 4 arms and 3 repeats on code from before the routing redesign. All 144 runs passed, so these tasks cannot separate the arms. They show cost only. `bench/results/stage-c-post49.jsonl` holds 21 partial rows on code from after #49. `bench/results/session-switch.jsonl` holds 12 mid-session runs on one task. In `bench/results/stage-agents.jsonl`, six rows were cut off by the print-mode wait ceiling, so leave them out of any comparison.

This is a pilot. It supports no saving claim.

## What keeps a run honest

- The workspace holds only the tree at `base`, in a new repository. The reference commit is out of reach through git.
- Hidden tests go in after the agent's change is saved, so the grader never sees them.
- Each `run_id` hashes the arm, the plugin code that arm runs, the prompt and the task, so a resume never reuses a row from another setup.
- A usage limit, a failed setup or a test command that never returns is not a result. Those rows stay out of the numbers.
- A run whose transcript shows the reference commit, the repository cache or another project's memory is left out.
- Intervals resample tasks, then repeats, stratified by cohort. Under 30 tasks, a report says pilot.

Claude Code runs on the host, so `leak_refs` detects reading the cache by path but does not prevent it. The neutral track prevents it with a sandbox.

A run with a test command that hangs is left out as a harness error, even when the agent's change caused the hang. Check the harness-error count in each report.

## Select tasks and confirm a claim

The first 12 tasks do not separate the arms, because every arm passes them. [`experiments/PREREGISTERED.md`](experiments/PREREGISTERED.md) fixes how the candidate tasks are screened, how hard and easy tasks are picked, when to stop, and which gates a claim must pass. `screen` runs fixed arms only, and its rows never count. Commit that file before the first screen run. Thresholds cannot change after results exist.

An experiment names its tasks, so a new task file never joins an older study.

## Outcome matrix and benchmark health

`report.mts` ends with three sections from `lib/outcomes.mts`. `node bench/outcomes.mts results.jsonl --out matrix.json` prints the same sections, and `report.mts --outcomes matrix.json` writes the same file. The file holds ids, hashes, verdicts and costs, never reply text.

- **Outcome matrix.** A cell is one task and one arm under one identity: model, policy, spec hash, environment, grader and harness SHA. Repeats share a cell. Two identities are never pooled. They show as a conflict, and the signals read the larger cell. A cell that never ran is missing, not zero. Each cell has an exact Clopper-Pearson interval over its repeats.
- **Health signals.** Three signals, never combined. Difficulty is the pass rate of a reference arm, `sonnet-high` by default (`--reference`). Outcome discrimination means the arms' per-task majority verdicts differ. A tie is not solved. Economic discrimination means two arms share a verdict, but one costs at least `COST_RATIO` (1.5×) the other per accepted run. Set-level numbers count tasks, never repeats. The report names `FOCUS_TASK` on all three.
- **Health warning.** Under 20% of comparable tasks with outcome discrimination, the report warns. The warning is a heuristic, not a release gate.
- **False completion rate.** Explicit completion claims that failed acceptance, divided by explicit claims with a valid grade. Prompt template `repo-change-v2` asks the final message to end with `Status: done` or `Status: not done`. The runner turns that line into the boolean `completion.claimed` and keeps no reply text (`lib/claim.mts`). Runs on `repo-change-v1` never asked, so they are N/A. A v2 run with no status line is ambiguous, also N/A. The report prints both counts. It also counts how often the completion gate's `verified` met failing hidden tests.

## Replay routes and pick tasks for a change

Both tools cost $0. They read records and results, and they call no model.

- **`route-replay.mts`** replays policy-auto routes from decision records. Each record holds `auto.replay`: the route input, the outcome and its provenance. `--mode exact` checks that this code reproduces each recorded route. It counts agreement only for records with this code's route fingerprint, and lists the others apart. `--mode counterfactual --policy <git-ref>` routes the same frozen evidence under another policy. That policy runs in a child process from a pinned worktree. `--policy-module <path>` runs a module instead, such as the Experiment A mutant in `fixtures/`. Records hold no prompt text, so `--mode classifier` only explains where judge changes are measured instead. A record without a complete input counts as unreplayable, by reason. No field is guessed.
- **`select.mts`** picks the tasks a router change should run on. It builds three parts, each with its rule in the output:
  - **Disagreement:** tasks whose recorded first route moves between this tree and `--policy`.
  - **Sentinel:** tasks whose past AutoMode runs used what the changed files own.
  - **Control:** a fixed set per cohort.

  `--experiment <name>` writes `experiments/pr-check-<name>.json` with the picked tasks. Its repeats and budget come from `PR_CHECK`, fixed before any result exists, and no run stops early. Its result covers the selected tasks only and is regression discovery, never a claim.

## Run the neutral track

This needs Docker and each vendor's API key. It spends real money, and a plan does not cover it.

```bash
export BENCH_SANDBOX_IMAGE='node:24-bookworm-slim@sha256:...'   # pin by digest
node bench/run.mts --experiment frontier-core --tasks-dir your-tasks --dry-run
```

Set `BENCH_LOCAL_URL` and `BENCH_LOCAL_MODEL` to use a local OpenAI-compatible server, with the `n-local` arm.

Model ids and rates live in `pricing/`. An `unverified` model is refused. `mistral-small-2603` is unverified. Rates change, so add a new dated file instead of editing an old one.

The adapters are tested against mocks built from vendor docs. Run one small task on each vendor before you trust a live result.

## External benchmarks

```bash
node bench/datasets/cli.mts list
node bench/datasets/cli.mts fetch swebench-verified --limit 20
node bench/datasets/cli.mts tasks swebench-verified --out /tmp/swe-tasks
node bench/run.mts --tasks-dir /tmp/swe-tasks --arms n-sonnet --repeats 1 --out bench/results/swe.jsonl
node bench/datasets/cli.mts predictions bench/results/swe.jsonl --out /tmp/swe-predictions
# Run the printed command with upstream's harness, then:
node bench/datasets/cli.mts import bench/results/swe.jsonl logs/evaluation/n-sonnet__r1/results.json --run n-sonnet__r1
```

SWE-bench's harness needs Docker and at least 120 GB, and arm64 is experimental upstream. Terminal-Bench runs through Harbor (`datasets/terminal-bench.mts`). Harbor's docs do not state its trial format, so check one real trial first. BigCodeBench and LiveCodeBench are diagnostics, not repository benchmarks, and they run in the sandbox.

## Safety and long context

```bash
node bench/safety/generate.mts safety --out /tmp/safety-tasks
node bench/safety/generate.mts longctx --out /tmp/longctx-tasks --tiers 32000,100000
```

Safety tasks plant traps, and they run only on the sandboxed runner. Never weaken that rule. A report counts unsafe runs, and over-refusal on benign security tasks.

`safety-model.mts` counts refusals on red-team sets. It needs `--approve-harmful-prompts` and a provider key, and it never uses `claude -p`. Read the vendor's terms first. Toxicity is not scored, because that needs a classifier this repository does not have.

## Delegated reads

A read gate acts only on runs that hit it, so a normal arm mostly measures nothing. At the shipped 5k tokens, only 3 of 76 tasks ever hit a full read that large. Test it in three cheap layers:

```bash
node bench/delegate-eval.mts                                  # one tool-free Haiku call per case
node bench/run.mts --experiment delegate-canary --out bench/results/delegate-canary.jsonl
```

`delegate-eval.mts` asks about this repository's own files and scores only findings that pass the evidence check. `delegate-canary` runs the `delegate-stress` arm at a 1.5k-token gate, on 4 cheap tasks, with a $3 cap. It reuses `auto` in `final-check.jsonl` as its baseline. The veto rules are in [`experiments/CANARIES.md`](experiments/CANARIES.md).

These runs test safety. They measure no saving and no gain in context size. `bench/waste-audit.mts` prices the upper limit: full reads in the audit's bloat list were about 1.6% of 30 days of spend.

## Classification

`node bench/classify-eval.mts` asks the real judges about real task prompts, several times each, and passes each answer through the real rules. It runs no task and costs cents. Run it before a live run. Results are in [`results/classification-2026-11-02.md`](results/classification-2026-11-02.md).

## Route learning

`node bench/learn-replay.mts` replays your own decision records through `lib/learn.ts` and costs nothing. A live run cannot test this feature, because it acts only after repeated failures across tasks in one project. The harness tests in `tests/learn.test.ts` cover that path.

## Quality checks

- `node bench/grade.mts results.jsonl --judges claude-sonnet-5-5,claude-opus-5-5` runs a panel. Disagreements go to `<results>.disputes.jsonl`. For a release, add a non-Claude judge.
- `node bench/calibration-report.mts --grades g.jsonl --human bench/calibration/human-scores.jsonl` compares judges with people. See `calibration/README.md`.
- `node bench/verify-manifest.mts results.manifest.json` checks a report's inputs. The `bench-attest` workflow signs a manifest.

## Tests and CI

`npm test` covers the harness with a fake `claude`, mocked vendors and a stand-in sandbox, so it needs no network and no model. CI also runs `node bench/validate-fixture.mts --offline` on every task file. Live scores never run in CI, because a provider outage must not block a merge, and nothing should spend your usage unattended.
