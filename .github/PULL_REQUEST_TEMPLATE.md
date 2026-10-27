## What changed and why

<!-- Two or three short sentences. Link the issue. -->

## How you checked it

- [ ] `npm run check` passes (type check and Node tests)
- [ ] `claude plugin validate . --strict` passes
- [ ] `claude plugin test .` passes (if you changed `hooks/`)
- [ ] I added or updated a test for the change

## Privacy

- [ ] No secrets, personal paths, real chat history or private project names
- [ ] No saved model reply text in `bench/results/`
- [ ] If I added a benchmark task, the repository is public, the license is MIT or Apache-2.0 (or BSD, ISC), and `node bench/validate-fixture.mts` says `valid`

## Release notes

<!-- One line for CHANGELOG.md, or "none". If this changes the mod, raise `version` in .claude-plugin/plugin.json. -->
