# Benchmark tasks

A task is one JSON file in this folder. See [`bench/README.md`](../README.md) for how the benchmark works. The runner (`node bench/run.mts`), the grader (`bench/grade.mts`) and the fixture check (`node bench/validate-fixture.mts`) read every `*.json` file here.

**This folder has no tasks yet.** Adding the first six is the most useful contribution to AutoMode. Without them, we cannot publish a result.

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
| `cohort` | One of the six. Aim for at least two tasks per cohort. |

The harness also reads schema 2, which nests the commands under `evaluation` and adds `regression`, `typecheck`, `limits` and `requirements`. The model never sees those fields, including `risk_tags`. See `normalizeTask` in `bench/lib/task-repo.mts`.

## What makes a good task

- The repository is small. The tests run offline in under two minutes.
- The task text states everything the hidden tests check. A test that needs a fact the agent cannot know is unfair to every arm.
- One language per task. The test command can be any shell command, so a task is not tied to Go, Node or Python.
- The task is a real change from the repository's history, not an invented one.

## Check your task

```bash
node bench/validate-fixture.mts your-task-id
```

The check validates the task file, clones the repository into `bench/.cache/` (ignored by git), and runs `accept` at `base` and at `reference`. It makes no model call and costs nothing. A valid task prints `"valid":true`.

Then open a pull request. Do not add anything from a private repository, and do not add real chat history to a task.
