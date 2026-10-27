# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2026-04-17

### Added
- `TierRouter` — drop-in wrapper around `anthropic.Anthropic` with three routing methods:
  - `.fast(messages, ...)` routes to Haiku 4.5
  - `.deep(messages, ...)` routes to Sonnet 4.6
  - `.auto(messages, hint=...)` picks tier based on task hint
- `CallRecord` + per-call cost accounting (`router.records`, `router.total_cost_usd`, `router.cost_breakdown()`)
- `estimate_cost(model, input_tokens, output_tokens)` helper using public Anthropic pricing
- Custom model override via `TierRouter(client, fast_model=..., deep_model=...)`
- `log_calls=False` flag to opt out of cost tracking
- Claude Code skill at `.claude/skills/tier-router/SKILL.md`
- 20-task reproducible benchmark (10 structured + 10 reasoning) with runner script
- GitHub Actions CI on Python 3.9 through 3.13
- 8 unit tests covering routing, cost accounting, custom models, log_calls flag

### Notes
- Pattern extracted from the dual-tier model routing in [orallexa-ai-trading-agent](https://github.com/alex-jb/orallexa-ai-trading-agent) where it cut per-analysis LLM cost from ~\$0.03 to ~\$0.003.
- Not yet on PyPI — install via `pip install git+https://github.com/alex-jb/claude-tier-router.git@v0.1.0`.

[Unreleased]: https://github.com/alex-jb/claude-tier-router/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alex-jb/claude-tier-router/releases/tag/v0.1.0
