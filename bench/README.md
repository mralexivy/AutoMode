# The AutoMode benchmark

This folder measures AutoMode and compares models. It has three tracks, and their numbers never mix.

| Track | Question | Runner | Experiment files |
|---|---|---|---|
| `automode-system` | Does AutoMode beat plain Claude Code? | `claude -p` | `light`, `effort`, `auto`, `stage-a`, `stage-b`, `stage-c`, `stage-c-opus` |
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

## What keeps a run honest

- The workspace holds only the tree at `base`, in a new repository. The reference commit is out of reach through git.
- Hidden tests go in after the agent's change is saved, so the grader never sees them.
- Each `run_id` hashes the arm, the prompt and the task, so a resume never reuses a row from another setup.
- A usage limit, a failed setup or a test command that never returns is not a result. Those rows stay out of the numbers.
- A run whose transcript shows the reference commit, the repository cache or another project's memory is left out.
- Intervals resample tasks, then repeats, stratified by cohort. Under 30 tasks, a report says pilot.

Claude Code runs on the host, so `leak_refs` detects reading the cache by path but does not prevent it. The neutral track prevents it with a sandbox.

A run with a test command that hangs is left out as a harness error, even when the agent's change caused the hang. Check the harness-error count in each report.

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

## Quality checks

- `node bench/grade.mts results.jsonl --judges claude-sonnet-5-5,claude-opus-5-5` runs a panel. Disagreements go to `<results>.disputes.jsonl`. For a release, add a non-Claude judge.
- `node bench/calibration-report.mts --grades g.jsonl --human bench/calibration/human-scores.jsonl` compares judges with people. See `calibration/README.md`.
- `node bench/verify-manifest.mts results.manifest.json` checks a report's inputs. The `bench-attest` workflow signs a manifest.

## Tests and CI

`npm test` covers the harness with a fake `claude`, mocked vendors and a stand-in sandbox, so it needs no network and no model. CI also runs `node bench/validate-fixture.mts --offline` on every task file. Live scores never run in CI, because a provider outage must not block a merge, and nothing should spend your usage unattended.
