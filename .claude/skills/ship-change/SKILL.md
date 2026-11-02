---
name: ship-change
description: The required workflow for any change to this repository, from issue to merged PR. Use it before you start a fix, feature, docs change or refactor here, and when asked to create an issue, a branch, a PR or a release. It keeps the release flow correct.
---

# Ship a change

Every task gets one issue, one branch and one PR. The branch holds the whole task: code, tests, benchmark and results. A task merges only when its evidence is on its branch. Nothing writes to `main` directly. CI enforces the branch and PR rules, so a shortcut fails in the `guard` job.

## 1. Sync

```bash
git status --short                # stop if tracked files are changed, and ask
git switch main
git pull --ff-only
```

## 2. Issue

Search first, so you do not open a duplicate:

```bash
gh issue list --state all --search "<words>"
```

If none fits, create one. Use the fields of the matching template in `.github/ISSUE_TEMPLATE/`: `bug_report`, `feature_request`, `benchmark_task` or `judge_case`.

```bash
gh issue create --title "<short title>" --label <bug|enhancement> --body-file <file>
```

## 3. Branch

Make one branch per task, not one per step. A task is one entity, even when its plan has phases, milestones or numbered parts. Those parts are commits on the task's branch and sections of its one PR. Never open a branch, issue or PR per phase, and never split a task so that its code lands first and its tests or benchmark follow.

When you plan a task, write the plan as one branch and one PR with ordered commits. Do not write it as "PR 1, PR 2, ...".

Use `<type>/<short-name>`. The type is `feature`, `fix`, `docs`, `chore`, `refactor`, `test` or `bench`. Keep the name to two or three words, in lowercase, with hyphens.

```bash
gh issue develop <N> --name feature/release-flow --base main --checkout
```

Always pass `--name`. Without it, the branch takes the whole issue title, and `guard` rejects it. This command also links the branch to the issue.

## 4. Work

- Keep to one task, and keep all of it here. Commit each phase of the plan on this branch as it is done.
- Add or update a test for each behavior change.
- Put the benchmark for the task on this branch, with the code it measures.
- If you change a shipped path, add a line under `[Unreleased]` in `CHANGELOG.md`. Shipped paths are `agents/`, `commands/`, `hooks/`, `output-styles/`, `scripts/`, `types/`, `workflows/`, `config.json` and `.claude-plugin/plugin.json`.
- Put the line under the right heading, because the heading sets the next version. `Fixed` and `Security` give a patch. `Added`, `Changed`, `Removed` and `Deprecated` give a minor.
- Never change `version` in `plugin.json`. The release PR does it.
- Never commit on `main`.

## 5. Check

```bash
npm run check
claude plugin validate . --strict
claude plugin test .
```

Fix every failure before you go on.

## 6. Benchmark

A change to what a session does needs a benchmark on its branch. That covers routing, model calls, tool gates, agents, the workflow and the guardian. A docs change does not need one, and neither does a fix that a test proves. Say so in the PR when you skip it.

1. Fix the pass rule before any result exists. Add the experiment to `bench/experiments/`, add its arm to `bench/arms.mts` if it needs one, write the veto rules in `bench/experiments/CANARIES.md`, and commit them.
2. State the expected spend. Ask the user before a run that spends usage or money. CI never runs a live benchmark, so this run happens here.
3. Run it on the branch's final code. A run id hashes the plugin code, so a later code change starts new runs.
4. Commit the rows and the report to the branch.

```bash
node bench/run.mts --experiment <id> --dry-run
node bench/run.mts --experiment <id> --out bench/results/<id>.jsonl
node bench/grade.mts bench/results/<id>.jsonl --budget-usd <n>
node bench/report.mts --manifest bench/results/<id>.manifest.json bench/results/<id>.jsonl
```

- A vetoed result blocks the merge. Fix the code and run again, or close the task.
- Never change a pass rule after results exist.
- A default of `off` or `shadow` does not replace this step.
- Under 30 tasks, a run is a pilot. It can veto a change, and it cannot prove a saving. See `bench/README.md`.

## 7. Pull request

```bash
git push -u origin HEAD
gh pr create --base main --title "<what changed>" --body-file <file>
gh pr checks --watch
```

- Fill in the template in `.github/PULL_REQUEST_TEMPLATE.md`.
- The body must contain `Closes #<N>`.
- Link the benchmark report, or say why the task needs none.
- Write the title as a plain sentence. A squash merge makes it the commit subject on `main`.
- Fix any failing check before you report the PR as ready.

If a change truly needs no changelog line, add the `no-changelog` label.

## 8. Merge

Merge only when the checks and the benchmark pass and the user asks:

```bash
gh pr merge <PR> --squash
```

Then go back to step 1 for the next change.

## What happens next

- A merge that changes a shipped path makes the bot open or update the `Release x.y.z` PR from branch `release/next`.
- Merging that PR ships. It runs the gate on Linux and macOS, builds and attests the bundle, publishes the GitHub Release, and moves `stable` last.
- Users install from `stable`, so `main` can hold unreleased work.
- Docs-only merges start no release. Their changelog lines wait for the next one.
- To choose the version: `gh workflow run release.yml -f bump=major`.
- To test the release path and publish nothing: `gh workflow run release.yml -f dry_run=true`.

## Do not

- Push to `main`, or merge with `--admin`.
- Merge a task while its benchmark is pending.
- Edit `release/next` by hand. The bot force-pushes it.
- Create tags, or move `stable`, by hand.
- Name a commit `Release x.y.z`. That subject starts a release.
