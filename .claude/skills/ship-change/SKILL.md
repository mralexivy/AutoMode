---
name: ship-change
description: The required workflow for any change to this repository, from issue to merged PR. Use it before you start a fix, feature, docs change or refactor here, and when asked to create an issue, a branch, a PR or a release. It keeps the release flow correct.
---

# Ship a change

Every change goes issue, branch, PR. Nothing writes to `main` directly. CI enforces these rules, so a shortcut fails in the `guard` job.

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

Use `<type>/<short-name>`. The type is `feature`, `fix`, `docs`, `chore`, `refactor`, `test` or `bench`. Keep the name to two or three words, in lowercase, with hyphens.

```bash
gh issue develop <N> --name feature/release-flow --base main --checkout
```

Always pass `--name`. Without it, the branch takes the whole issue title, and `guard` rejects it. This command also links the branch to the issue.

## 4. Work

- Keep to one topic.
- Add or update a test for each behavior change.
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

## 6. Pull request

```bash
git push -u origin HEAD
gh pr create --base main --title "<what changed>" --body-file <file>
gh pr checks --watch
```

- Fill in the template in `.github/PULL_REQUEST_TEMPLATE.md`.
- The body must contain `Closes #<N>`.
- Write the title as a plain sentence. A squash merge makes it the commit subject on `main`.
- Fix any failing check before you report the PR as ready.

If a change truly needs no changelog line, add the `no-changelog` label.

## 7. Merge

Merge only when the user asks:

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
- Edit `release/next` by hand. The bot force-pushes it.
- Create tags, or move `stable`, by hand.
- Name a commit `Release x.y.z`. That subject starts a release.
