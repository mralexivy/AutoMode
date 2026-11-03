# Benchmark runbook

These are the exact commands. [BENCHMARK_ARCHITECTURE.md](BENCHMARK_ARCHITECTURE.md) explains why each one exists. Every command here is free except **Run**.

## 1. Preflight (free, before any paid run)

```bash
npm run check                                            # type check, Node tests, fake-claude simulations
node bench/preflight.mts --experiment rescue-confirm     # fixtures, agent env, split, history, tests, tree, lock, budget
node bench/status.mts --experiment rescue-confirm        # slots: done, reused, new, stale, unknown; gate; spend
node bench/run.mts --experiment rescue-confirm --dry-run # the exact task x arm x repetition list
```

The preflight writes `bench/results/preflight/<id>.json`. A failing check names the task and the reason.

- **An invalid fixture.** Fix the task, then run the preflight again. The task's run ids change with its setup, so old rows of that task cannot be counted. If the fix needs time, take the task out of the experiment before any row exists, and say so in the experiment description. Never swap tasks after the first row.
- **The budget check fails.** Lower the scope, or raise `budget_usd` in the experiment file, before any row exists.

## 2. Approve, then run (paid)

A person approves the experiment file, the preflight report and the spend first.

```bash
# Foreground, for a short run:
node bench/run.mts --experiment rescue-confirm

# Detached and limit-safe, for a long run (macOS):
launchctl submit -l automode-bench -o /tmp/automode-bench.log -e /tmp/automode-bench.log -- \
  "$(command -v node)" "$PWD/bench/supervise.mts" -- --experiment rescue-confirm
tail -f /tmp/automode-bench.log
# Linux:
systemd-run --user --unit automode-bench --working-directory "$PWD" node bench/supervise.mts -- --experiment rescue-confirm
```

| Runner exit | Meaning | What to do |
|---|---|---|
| 0 | the plan is done | analyze (step 5) |
| 2 | the gate refused: no preflight, a failed one, or the plan changed | run the preflight again |
| 3 | another experiment holds the lock | wait for it to finish, or stop it |
| 4 | integrity defect mid-run: setup failed or the harness broke | stop and diagnose (step 4); do not resume until it is fixed |
| 75 | usage limit | see "When the quota hits" |

## 3. When the quota hits

1. The runner stops starting new runs at once. Runs already in flight finish. It writes `QUOTA_PAUSED` and exits 75.
2. Read `cat bench/results/<id>.status.json`. Its `reset_at` is the time the CLI stated, or `null`.
3. Under `supervise.mts`, a stated reset resumes on its own. With `null`, it stops.
4. To resume by hand, run the same command again. Finished rows are skipped. A cut-off row is no result and runs again. A run left `UNKNOWN` waits.
5. An `UNKNOWN` slot may already have been billed. Look at its partial transcript first: `node bench/status.mts --experiment <id> --json`, then its `session_id`. Only then authorize it with `--retry-unknown`.

Never start a second experiment to use the time. The lock refuses it anyway.

## 4. When code has to change mid-experiment

1. **Stop.** `launchctl remove automode-bench`, or Ctrl-C. Finished rows are safe.
2. **Classify the defect.** Is it in the product, the fixture, the grader, the runner, or the analysis? Record it in the experiment's report.
3. **Fix it on a branch.** Give the experiment a new version (`rescue-confirm-v2.json`) if the experiment itself changes. Never edit a live experiment in place.
4. **Check what the fix invalidates, for free:**

   ```bash
   node bench/reuse-audit.mts bench/results/rescue-confirm.jsonl --from <old sha> --to <new sha>   # per-row: stands or reruns, and why
   node bench/regrade.mts bench/results/rescue-confirm.jsonl --diffs bench/results/diffs     # a grader fix: no paid rerun
   node bench/decide.mts bench/results/rescue-confirm.jsonl --policy <policy>                # an analysis fix: no paid rerun
   ```

5. **Preflight the new version.** Point `reuse_from` in the new experiment file at the old results, so rows with identical run ids are copied, not paid for. Only then run again.

## 5. Diagnose, regrade, reanalyze (free)

```bash
node bench/status.mts --experiment <id> --json      # every slot, its status and why; spend and waste; quota; decision
node bench/regrade.mts bench/results/<id>.jsonl --diffs bench/results/diffs
node bench/decide.mts bench/results/<id>.jsonl --policy bench/experiments/policies/rescue-ship-v1.json [--grades <grades.jsonl>] --out decision.json
node bench/reuse-audit.mts bench/results/<id>.jsonl --changed hooks/lib/rescue.ts
node bench/transcript-fixture.mts <session-id> <name> --why "..."   # a new incident becomes a permanent regression test
```

## 6. Stop

```bash
launchctl remove automode-bench        # macOS supervisor
systemctl --user stop automode-bench   # Linux supervisor
# or Ctrl-C on a foreground run. A run in flight becomes UNKNOWN; nothing finished is lost.
```
