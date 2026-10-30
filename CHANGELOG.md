# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
