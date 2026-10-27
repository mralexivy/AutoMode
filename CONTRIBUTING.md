# Contributing to AutoMode

Thank you for your help. This guide takes five minutes to read.

## Set up

1. Fork the repository and clone your fork.
2. Install Claude Code 2.1.287 or later. Check with `claude --version`.
3. Install the dev tools with `npm install`, then run all checks with `npm run check`. You need Node 23.6 or later. It runs TypeScript directly, so there is no build step.
4. Load the mod from your working tree: `claude --plugin-dir .`

AutoMode is a Claude Code **mod**: a plugin whose code registers event handlers. If mods are new to you, read the [mods overview](https://code.claude.com/docs/en/plugins/mods/overview) and [Create a mod](https://code.claude.com/docs/en/plugins/mods/create).

The entry point is [`hooks/register.ts`](hooks/register.ts), declared in [`hooks/hooks.json`](hooks/hooks.json). Its types come from the `claude-code` package that Claude Code provides. When you load the mod with `--plugin-dir`, Claude Code writes the type declarations for your version into `.claude-plugin/types/`, and reloads the mod when you save.

## The checks

Run these before you open a pull request:

```bash
npm run typecheck                    # tsc: types of the tests and bench scripts
npm test                             # node:test: the .test.mts files
claude plugin validate . --strict    # reads the mod the way Claude Code does
claude plugin test .                 # the .test.ts files, in the Claude Code test harness
```

`claude plugin validate` reads the mod the way Claude Code does and lists the `hooks:` and `calls:` of the mod. Follow its rules: write every mods API call in full (`$.fs.read(...)`, never `const fs = $.fs`), pass an event name as a string literal, and pass a literal name to `$.env.get`.

## TypeScript, not JavaScript

All code here is TypeScript, except two groups of files that must stay JavaScript:

- **`scripts/*.mjs`** run on a user's machine through `node`, and a user's Node may be older than 23.6. They need no build step and no type stripping.
- **`workflows/run.js`** is loaded by Claude Code itself.

Two kinds of test file exist, and the extension tells them apart:

| File | Runs with | Why |
|---|---|---|
| `tests/*.test.ts` | `claude plugin test .` | They use the Claude Code test harness, `claude-code/testing`. |
| `tests/*.test.mts` and `bench/*.test.mts` | `npm test` (`node --test`) | Plain Node tests. The `.mts` extension keeps `claude plugin test` from picking them up, and it means ES module. |

Bench scripts are `.mts`. Write erasable TypeScript only: no `enum`, no `namespace`, no constructor parameter properties. `tsc` enforces this.

**The type check is a ratchet.** Every `.mts` file is checked by default, so a new file must pass. Thirty-three older files start with `// @ts-nocheck TODO(types): N errors`. To fix one, delete that line, run `npm run typecheck`, and fix what it reports. `grep -l ts-nocheck -r bench tests` lists what is left.

## Where to help

- **Benchmark task.** Add a file to `bench/tasks/` with a public repository (MIT, Apache-2.0, BSD or ISC), two pinned commits, hidden tests and a test command. Read [`bench/tasks/README.md`](bench/tasks/README.md), then run `node bench/validate-fixture.mts <id>`.
- **Judge case.** Add an entry to the `cases` list in `bench/judge-cases.json`. Use an id that starts at `c01`. The format is `{ "id", "kind", "current": { "model", "effort" }, "message", "ok": [efforts a careful person accepts] }`. Write the prompt yourself. Do not paste real chat history.
- **Risk rule.** Add a pattern in `hooks/lib/risk.ts` and a test in `tests/`.
- **Docs and images.** Fix a sentence, or add a real screenshot to `docs/readme/`.

## Rules

- Do not commit secrets, keys, personal paths or private data. Test fixtures must use fake values. The `private-data` CI job fails on a personal path.
- Do not commit real session transcripts, or results that come from them.
- **Do not save the text of model replies** in `bench/results/`. A reply can echo the name of the account that ran the check.
- Add or update a test with every behavior change.
- Keep a change small and focused. One topic per pull request.
- Write comments and docs in short sentences. Active voice. One idea per sentence.
- Do not claim a cost saving without a benchmark run that others can repeat.

## Releases

Claude Code caches an installed plugin by version. So raise `version` in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) with every change to the mod, add a line to [`CHANGELOG.md`](CHANGELOG.md), and say in the README which Claude Code version you tested with.

## Pull requests

1. Open an issue first for a large change.
2. Run the checks above and fix any failure.
3. Describe what changed and why. Link the issue.

By contributing, you agree that your work is released under the [MIT license](LICENSE).
