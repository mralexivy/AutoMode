# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AutoMode is a Claude Code **mod**: a plugin whose TypeScript registers event handlers. It picks a model and an effort for each prompt, runs a plan, build, verify and review workflow, and watches the session with a guardian. The mod has no install step and no build step. Claude Code loads the `.ts` files directly. `npm` tooling exists for development only, and it needs Node 23.6 or later.

## Commands

```bash
npm install                          # dev tools only
npm run check                        # type check, then the Node tests
npm run build                        # release bundle in dist/, validated
npm run typecheck
npm test                             # tests/*.test.mts and bench/*.test.mts
node --test tests/bands.test.mts     # one Node test file
node --test --test-name-pattern='demandBand' tests/bands.test.mts   # one Node test by name
claude plugin validate . --strict    # reads the mod the way Claude Code does
claude plugin test .                 # tests/*.test.ts and *.test.tsx
claude --plugin-dir .                # load the working tree; it reloads on save
```

Run all four checks before you call a change to `hooks/` done: `npm run typecheck`, `npm test`, the validator and `claude plugin test .`.

**Two test runners.** The extension decides which one runs a file:

- `*.test.mts` runs under `node --test`. Use it for pure modules, and for anything with no engine.
- `*.test.ts` and `*.test.tsx` run under `claude plugin test`, with the `claude-code/testing` kit. `tests/harness.ts` stands in for the engine. This runner takes a folder only, so it cannot run one file or one test by name.

**What the type check misses.** `tsc` starts from `.mts` files and follows their imports into `hooks/`, with `claude-code` stubbed as `any` in `bench/stubs.d.ts`. So it does not check `*.test.ts` files or the mods API calls. The validator and `claude plugin test` cover those. `strict` is off. Write erasable TypeScript only: no `enum`, no `namespace`, no constructor parameter properties. 33 older files start with `// @ts-nocheck TODO(types)`. A new file must pass without that line.

## Architecture

`hooks/hooks.json` names one module, `hooks/register.ts`. Its `register` function binds every engine event. The guardian sees each prompt first, and then the router decides the route.

| Layer | Files | Role |
|---|---|---|
| Wiring | `hooks/v4.ts`, `hooks/guardian.ts` | Own all `$` engine calls and module state. They move values between the engine and the pure modules. |
| Pure logic | `hooks/lib/*.ts` | No `$` and no I/O. Each file opens with a comment that states its contract. `lib/io.ts` is the one exception. |
| UI | `hooks/ui/` | `publish.ts` writes the `automode.view` atom, and every drawing reads it. A drawing never calls `publish`. |
| Workflow | `workflows/run.js`, `agents/*.md` | The `automode:run` workflow and its six agents. It runs in a different runtime from the hooks and shares no imports with them. |
| User scripts | `scripts/*.mjs` | Run through a user's `node`, which may be older than 23.6. |
| Evidence | `bench/` | Benchmarks and offline transcript tools. Most of `bench/external/` is vendored upstream code with checksums. Do not edit it. |

**How a route is decided.** `v4PromptSubmit` runs `decideAuto` under policy `auto`, the shipped policy. Policy `legacy` is the interval optimizer in `lib/optimizer.ts`.

1. Two Haiku judges give evidence: the effortless judge (`lib/effortless.ts`) and the AutoMode judge (`lib/classify.ts`).
2. `lib/consequence.ts` and `lib/risk.ts` set quality floors.
3. `optimizeAuto` in `lib/auto.ts` picks the cheapest eligible model and effort pair.
4. `resolve` in `lib/authority.ts` applies the order that matters: a user override or workflow role is final, the floor lifts the candidate, and the switch check in `lib/policy.ts` then holds or switches on cache cost. A hold never drops below the floor.

Effort can change per prompt while the model holds, because an effort change keeps the cache where the provider shares it. `v4TurnStep` applies the route to each request.

**Settings precedence**, lowest first: code defaults, `config.json`, the plugin `userConfig`, then environment switches such as `AUTOMODE_ROUTER` and `AUTOMODE_POLICY`. See `lib/settings.ts`.

**Failure behavior.** Hooks fail open: a routing error falls through to `next(e)`, and a failed judge never blocks a prompt. The tool guards fail closed: `tool.call` denies the call if the guard throws before the call runs.

## Traps

- **Keep this file in `.claude/`.** A `CLAUDE.md` at the repository root is a warning to `claude plugin validate`, so `--strict` fails, and CI runs `--strict`.
- **Stale comments.** The headers of `register.ts` and `v4.ts` describe an AutoMode picker row, but `activation` now defaults to `always`. `hooks/options.ts` names `hooks/ui/settings.tsx`, which does not exist. The "external signals writer" in `v4.ts` is not in this repository.
- **Two routers in `register.ts`.** The classic judge router runs only with `"router": "judge"`. `config.json` ships `"v4"`, so routing changes belong in `v4.ts` and `lib/`.
- **Duplicated risk patterns.** `HIGH_RISK` in `register.ts` and `RISK_RULES` in `workflows/run.js` hold the same S3 text regexes. A comment says a test keeps them identical, but no test does. Change both by hand. V4 routing itself uses `lib/risk.ts` and `lib/consequence.ts`.
- **Validator rules.** Write every mods API call in full (`$.fs.read(...)`, never `const fs = $.fs`). Pass event names and `$.env.get` names as string literals.
- **The `calls:` line.** The validator cuts this line at 1,000 characters, and the mods catalogue refuses a cut line. CI fails on it too. Busy host calls therefore go through the function declarations in `lib/io.ts`. Keep them as declarations that pass `$` through.
- **The `directory` branch.** The Anthropic directory reads `$` only within one file, so `tools/release.mts directory` publishes the shipped files with `hooks/` bundled into one module. Pure `lib/` files stay separate. Never name a local variable `on` or `next` in `hooks/`. The portal's Validate button accepts `owner/repo@branch`, so try a change there first.
- **`lib/effortless.ts` is a verbatim port.** `tests/effortless-fidelity.test.mts` fails if its code differs from the vendored source. Put changes in `lib/effortless-adapt.ts`, each with its reason and a test.
- **`tests/golden/decisions.json`** pins optimizer and switch-check behavior. When a change to the assumptions moves a case, update that case on purpose.
- **`workflows/run.js` has a top-level `return`.** `tests/workflow.test.mts` wraps it in an `AsyncFunction` with mocked globals. Keep it as JavaScript.

## Repository rules

- Follow the `ship-change` skill for every change: issue, branch, pull request. Nothing writes to `main` directly.
- Do not change `version` in `.claude-plugin/plugin.json`. The release PR raises it, and also updates the README. Add a line under `[Unreleased]` in `CHANGELOG.md` when you change a shipped path.
- CI rejects personal absolute paths anywhere in the repository, and a `"text":` field in `bench/results/*.json`. Never save model reply text or real session transcripts.
- Do not claim a cost saving without a repeatable benchmark run. `bench/tasks/` holds no tasks yet.
- Add or update a test with every behavior change. Keep one topic per pull request.
- Write comments and docs in short sentences, in active voice, with one idea per sentence.
