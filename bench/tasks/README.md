# Benchmark tasks

A task is one JSON file in this folder. See [`bench/README.md`](../README.md) for how the benchmark works. The runner (`node bench/run.mts`), the grader (`bench/grade.mts`) and the fixture check (`node bench/validate-fixture.mts`) read every `*.json` file here.

This folder holds 76 tasks. The first 12 are the dev set, two per cohort. Every arm passed all 12, so they never count as proof. The other 64 are candidates for the task screen: 54 new tasks from 29 repositories, and 10 `-v2` tasks. A candidate has no hard or easy label until the screen gives it one. See [`bench/experiments/PREREGISTERED.md`](../experiments/PREREGISTERED.md). More tasks are the most useful contribution to AutoMode, because results under 30 tasks are a pilot.

A `-v2` task is an existing task with its location hints removed, its `accept` widened, or both. It keeps the same commits. A study runs one version of a task, never both.

The Python tasks passed on Python 3.9.6, and they target that version: `refactor-pymarkdown-block-level` needs `pkg_resources`, and later Python may fail tasks for reasons unrelated to an agent. The Node tasks passed on Node 26. Run `node bench/validate-fixture.mts` on your own machine before a paid run.

## The task file

```json
{
  "id": "short-kebab-case-id",
  "cohort": "trivial | feature | refactor | security | migration | longctx",
  "repo": "https://github.com/owner/name",
  "license": "MIT",
  "base": "40-character commit SHA the agent starts from",
  "reference": "40-character commit SHA of the real change",
  "task": "The request, written the way a person would type it. State every fact the hidden tests check.",
  "hidden_tests": ["path/to/test_file_changed_by_the_reference_commit"],
  "accept": "the command that runs the hidden tests, for example: npm test --silent",
  "setup": "optional: a command that installs dependencies, for example: npm ci",
  "lint": "optional: a command that must pass for a clean change"
}
```

| Field | Rule |
|---|---|
| `repo` | An https URL of a **public** repository. |
| `license` | `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause` or `ISC`. Check the repository's `LICENSE` file yourself. |
| `base`, `reference` | Full 40-character SHAs. `reference` must be a descendant of `base`. |
| `hidden_tests` | Test files that the reference commit adds or changes. The runner copies them from `reference` after the agent finishes. |
| `accept` | Must fail with the hidden tests at `base` and pass at `reference`. |
| `cohort` | One of the six. Aim for at least two tasks per cohort. It names the shape of the change, not its difficulty: a bug fix in one area is `feature`, and a fix that crosses modules is `longctx`. |

The harness also reads schema 2, which nests the commands under `evaluation` and adds `regression`, `typecheck`, `limits` and `requirements`. The model never sees those fields, including `risk_tags`. See `normalizeTask` in `bench/lib/task-repo.mts`.

## What makes a good task

- The repository is small. The tests run offline in under two minutes.
- The task text states everything the hidden tests check. A test that needs a fact the agent cannot know is unfair to every arm.
- One language per task. The test command can be any shell command, so a task is not tied to Go, Node or Python.
- The task is a real change from the repository's history, not an invented one.
- The task can separate models. Lead with the symptom, as a person files a bug. State every fact the tests check, but not where or how to fix it: no file paths, no private names, no hint at the fix. A path is fine only when a test imports it.
- `accept` runs the full relevant suite, not one narrow file, so a regression counts. Leave out a test only when it fails at `reference` on its own, such as one that needs the network or a missing submodule.
- A test that only pins a time limit is not a fair task. It depends on the machine.
- Use at most 3 tasks per repository.

## Check your task

```bash
node bench/validate-fixture.mts your-task-id
```

The check validates the task file, clones the repository into `bench/.cache/` (ignored by git), and runs `accept` at `base` and at `reference` in the same kind of workspace a real run gets: the tree at that commit, with no project history. It makes no model call and costs nothing. A valid task prints `"valid":true`.

Then open a pull request. Do not add anything from a private repository, and do not add real chat history to a task.
