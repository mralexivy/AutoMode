# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- The route now follows the task, not the model the session started on. One effortless answer with a fixed anchor (`Current: sonnet`) decides the model, and the running model is asked only for its own effort.
- Opus now needs T4, a Fable verdict, an escalation floor, T3 with critical work, or T3 with the need naming Opus. Otherwise the route is Sonnet, or Haiku when both judges name it. Price is only a tie-break.
- An upgrade that only the judges ask for now waits for the switch gate. Floors, escalation, T4, real work on Haiku and provider limits still move at once.
- Decision records now hold the need and its anchor, and outcome records hold the route and the AutoMode tier.
- Native `/model` and `/effort` now stand for the session, until `am:reset`. Before, routing overwrote them without notice.
- `routeModels: false` keeps the model you picked from the first prompt. A first-prompt judge failure does too.
- A failed judge raises task risk only until a judge answers again.
- A short message, or one the judge rates as no risk, still goes through the text and path risk checks.
- A return to a warm model is priced for the turns its cache lacks, and a compaction clears that warm state.
- The effort judge is asked as upstream asks it, and gets the closing line only when it gave no verdict. The line pushed some verdicts too low.
- A return to a warm model is priced for turns added after a thinking drop, and the legacy policy reads what that cache holds.
- A model switch that loses the running model's thinking holds inside a task. A mandatory switch still goes and logs it. A compaction clears the flag.
- A cold cache inside a task no longer skips the risk, confidence and dwell gates. A low point is priced as the difference between the two cache writes.
- An upgrade compares capability, not tier, and needs a model that is not weaker. Sonnet max to Opus low is not an upgrade, and neither is Opus low to Sonnet high.
- A shrink with no compaction noted since the last request is priced as a warm switch, and step pricing uses the cache lifetime's write rate.
- A calibrated `effortOutput` is read, a hold records the tier of its effort, and `underRouting` records only real corrections.
- A plain `grep`, `rg` or `diff` that must find nothing no longer fails the workflow on exit 1. Verifier reports carry `expected_exit`, and it counts for no other command.
- The workflow's `stages` win over `mode`, so the conditional stages run on the router path.
- The workflow band counts planned and changed files and blocking unknowns, not files that explorers cited, and the router sends the real tier.
- The workflow fixes major correctness and security defects as well as blockers, sends evidence gaps to the verifier, and skips the fix pass when there is no defect.
- Subagents take the task's risk: on critical work a general-purpose agent keeps the parent's model unless it only reads, and a diagnoser runs on Sonnet when the task carries risk. Effort is the stronger of the helper's pick and the policy.
- Removed the unsupported "73%" figure from the subagent reason.

### Changed

- Automatic workflow entry is off by default (`autoWorkflow: false`). `am:run` still works. Decision records show what entry would have done, and `workflow-entry` records show whether a chosen workflow was called.
- The workflow result carries `next_action`, and its trace carries `effort`. `planModel` and `reviewModel` args set those models below S3. The defaults stay Opus.

### Added

- Each decision records the shadow rent rule's verdict beside the live one. It changes no route.
- A `model-switch` record notes the continuity flag and the tokens the prompt dropped on arrival.

## [0.2.1] - 2026-10-30

### Fixed

- Host calls in the files that declare hooks are written in the plain form that the plugin directory reads.
- `/automode:usage` pre-approves only its own script, not every `node` command.
- A release also publishes a `directory` branch: the shipped files, with `hooks/` bundled into one readable module, for the plugin directory.

## [0.2.0] - 2026-10-30

### Changed

- New installs come from the `stable` branch, which moves only after a release passes its checks. They no longer get unreleased work from `main`.
- The plugin description now says what AutoMode does today, under the name AutoMode for Claude Code.

### Added

- GitHub Releases carry a bundle, checksums and a build attestation.

## [0.1.2] - 2026-10-30

### Added

- A capture of a real session in the README.
- `tests/route-matrix.test.mts`: route invariants checked across every judge, consequence and allowed-model combination.

### Changed

- T4 work and a Fable verdict never run Opus below high. There is still no automatic Fable route.
- Critical work that is not trivial gets an Opus medium floor, next to its Sonnet high floor.
- T3 and T4 work never runs at low, also when only one model is left. An explicit user effort still wins.
- The workflow implementer runs Sonnet high, for better results on multi-module work. Expect its Build stage to cost more, about 1.7 times on Anthropic's published numbers.
- The workflow explorer declares Haiku medium, the effort it already ran at in auto mode.

## [0.1.1] - 2026-10-30

### Changed

- Four busy host calls go through `hooks/lib/io.ts`, so `claude plugin validate` prints the whole `calls:` line. Behavior does not change. The mods catalogue refuses a new seed when that line is cut.

### Added

- A CI check that fails if the `calls:` line is cut again.

## [0.1.0] - 2026-10-30

First open source release.

### Added

- The mod: a model and effort router with a Haiku judge, a five-step ladder, quality floors, and a cache-aware hold.
- The `automode:run` workflow with six agents: explorer, architect, implementer, verifier, reviewer and diagnoser.
- The guardian: secret redaction, risky-turn pauses, tool result shortening, task checkpoints, and a git guard for subagents.
- The bar above the prompt, and the `/automode` command with `status`, `details`, `on`, `off`, `setup`, `settings`, `debug` and `help`. Also `/automode:usage`.
- The `automode:Concise` output style, with an output style check in `bench/style-check.mts`.
- The benchmark harness in `bench/`: a task runner, a blind grader, a fixture check and offline cost tools.
- The judge benchmark, with labeled cases from effortless.
- Development in TypeScript: bench scripts and Node tests are `.mts`, with a type check that every new file must pass.

### Changed

- AutoMode starts with every session. It no longer needs a special model ID: Claude Code 2.1.311 removes the `[1m]` suffix, so that rule never fired. The old rule stays as `"activation": "picker"`.

### Known limits

- `bench/tasks/` has no tasks yet, so no public benchmark result is published.
- The bar is not drawn in the VS Code extension. Use `/automode` there.
- The images in the README are illustrations, not screenshots of a live session.
