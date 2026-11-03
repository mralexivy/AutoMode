# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- A check run in a copy under `/tmp` is no check of the work. On tomlkit, the model copied its new tests next to the original code to show that they fail there, and that read as a regression, which moved Haiku to Sonnet. A test the task added or edited never joins the stash baseline, so it cannot excuse its own later failures.
- The completion gate reads a stated example written as code whole. It split on `: ` and `, ` inside brackets and quotes, so qs's `qs.parse({ a: arr, 'a[]': 'y' })` became the input `y' })`. A trailing ", and arr must stay ..." clause also became part of the expected value. Every check that named the input then read as a contradiction, and the gate climbed to an Opus consult: $1.99, against $0.16 for Sonnet high.
- A test that fails on the stashed original code is the repository's own failure. A later run that fails only on such tests no longer fails the completion gate or climbs the ladder, unless the task names the test or asks to fix failing tests. On pyjwt, a TLS test failed on the untouched code, and AutoMode climbed to Opus on it: $1.55, against $0.32 for Sonnet high.
- A test regression needs evidence in the output: a failing test, a runner's failure line or a compile error. An exit code alone is often a probe script run beside the check. All three regressions the 2026-11-03 run escalated on were that, on xmltodict, cachetools and marked.
- A test run whose only errors are a program the machine lacks, such as `python` where only `python3` exists, is no verdict on the work. It no longer fails the completion gate or climbs the ladder. On sqlglot, `test_lazy_load` failed this way before and after every edit, and AutoMode climbed four rungs to Opus on it: $2.71 of a $4.93 run that still failed.
- Under `opusStart: evidence`, a review the model asks for on its own also runs on Sonnet, unless a critical failure was observed. The reviewer agent's own default is Opus, and on cachetools such a review cost $0.46 of a $1.21 run.
- A failing line whose test runner printed a clean pass is filed under the whole line, not as a failure of the suite. On xmltodict, `pytest | tail; python3 -m doctest x.py` printed `100 passed`, and old doctests failing read as a test regression, which moved Haiku to Sonnet.
- A check that never started, such as `command not found: python`, is no longer a passed check. A trailing `; echo "exit=$?"` now counts as a masked exit code. In the benchmark, such a run counted as a pass on marshmallow and started a re-route.
- A file named `schema` is a database schema only as `db/schema*`, `schema.prisma` or `schema.rb`. Editing marshmallow's `schema.py` had made the task critical and moved it from Haiku to Sonnet after its fix was done.
- The completion gate no longer reads a described result as a printable example. "x must be a separate list equal to ['foo']" had made every check that named x a contradiction, and the gate blocked a finished jinja task, which then bought a fork and an Opus consult.
- A revert command counts as escalation evidence only when an edited file has lost its change. A model that checks out the old file to prove its new tests fail, then copies its fix back, keeps its work. In the benchmark, findmyway moved from Haiku to Sonnet on exactly that, for $0.27 of its $0.30.

### Changed

- Under `opusStart: evidence`, a run on Haiku keeps working through repeated check failures, the write-test, fail, fix loop. It moves to Sonnet on a regression, a revert, a reviewer blocker, or a stop with the last check failing, which is now always sent back once. An escalation no longer adds a review of its own. In the benchmark, Haiku's first repeat had counted as 'failed at the top effort' and moved immer to Sonnet, plus a review: $0.77, against $0.26 for Sonnet high.
- Haiku first: under `opusStart: evidence`, T0 to T3 work without critical risk can start on Haiku, whatever model a judge's need names. T3 starts at high effort. A failing check moves the task to Sonnet through the ladder. Critical-risk work stays on Sonnet high. Haiku passed 27 of the 28 proof-run tasks it has rows for, at about a tenth of Sonnet high's cost, while AutoMode had sent 25 of them to Sonnet.
- The independent review runs on Sonnet unless the diff itself shows critical risk. Before, a prompt rating or a rescue rule bought an Opus review. In the proof run those reviews were all of AutoMode's Opus spend ($2.07 of $9.11), and none changed an outcome.

### Changed

- T3 work now starts on Sonnet high, not Opus (`opusStart: evidence`). Opus comes from the escalation ladder, on a failing check, a regression or a reviewer blocker. T4 and a Fable verdict still start on Opus, and Haiku routing is unchanged. In the 30-task proof run, the old rule sent 15 tasks to Opus for $12.49, and Sonnet high passed all 15 for $4.51. `opusStart: judge` restores the old rule.

### Fixed

- A Bash line that runs the full test suite beside other checks is now keyed on the full suite. A `--version` call in parentheses no longer counts as a check run. Before, one sqlglot suite got 3 keys across its runs, so its repeats went unseen.

### Changed

- The rescue ladder ships on: `strongStep: effort-first`, `consult: priced`, `packet: fork-gated` and `forkRung: on`. With these settings and `opusStart: evidence`, AutoMode passed 29 of 30 tasks at 32% lower cost than Opus medium ([report](bench/results/automode-proof-2026-11-03.md)). The ladder's effect alone, against the old defaults, is not settled: the 30-task run judged it inconclusive. Each setting keeps its old value as an option.

### Fixed

- The escalation ladder now sees edits made through Bash (`sed -i`, a heredoc that writes a file, a redirect, `git apply`). It keys a check on its check commands alone, not the whole Bash line. Before, a session that edited and tested in one call got a new failure each time and never escalated.
- The same check failing 3 times after edits, each time with other tests, now counts as a repeat of the check.
- A test run that reports failed tests now counts as a defect even when a later line looks like a missing module. Before, a stray `No module named` after `FAILED (failures=3)` filed sqlglot's real failures as environment noise, so the escalation ladder never acted on them. Python unittest's `FAIL:` and `ERROR:` lines now name the failing tests, and its `FAILED (failures=…)` summary marks a masked check as failed.

### Added

- Escalation records carry the cache state: prefix size, time since the last refresh, and what is left of its lifetime. Each architect consult writes a `consult-run` record with its measured duration and cost. A `baseline` bench arm pins every rescue setting at its old value.
- `strongStep: effort-first` raises effort on the running model once per failure episode, on strong evidence, before the Opus consult and the switch. Critical-risk work and a floor that needs the model skip it. The value `model` keeps the old order. Arm: `rescue-effort-first`.
- `consult: priced` asks the Opus architect only when that costs less than moving the session. The price counts what is left of the cache lifetime against how long a consult runs, one verify request, and the chance the failure comes back and still needs the switch. Quality rules come first. Unmeasured inputs are labeled priors, and each escalation record carries the estimate. The value `always` keeps the old behavior. Arm: `rescue-consult-priced`.
- Each ladder consult gets an outcome record: `verified_resolved`, `recurred`, `escalated`, `unverified` or `abandoned`. A passing check alone is not a fix. It also needs the reviewer's approval or a verified completion gate. The record also says whether the edits after the consult followed the architect's plan. The bar shows an open consult. Under a rescue setting, a consult or a strong-evidence raise also requires the independent review.
- `packet: rich` gives the Opus consult a packet where each fact names its source. It holds the person's later messages, the diff from git, every failing check with a 40-line tail, and what was tried. `packet: fork-gated` adds a same-model `$.model.fork` only for a gap the conversation could fill, and only while the fork costs under a quarter of the consult. Its record keeps the measured cache read. The value `basic` keeps the old packet. Arms: `rescue-packet-rich`, `rescue-packet-fork`.
- The guardian's lifecycle record carries `expected`: a fuller compaction model, recorded in shadow. It adds context regrowth, the chance the cache expires before the next request, and the cost of re-reading a detail the summary drops. It changes no offer.
- `forkRung: on` adds a rung before the Opus consult. The main model starts a `fork` agent, which shares the conversation and its warm cache, to diagnose the failure without editing. A `fork-run` record measures its cost and how much of its first request the cache served. Arm: `rescue-fork`.
- Under a rescue setting with `completionGate: block`, a stop on a failing check is strong evidence for the ladder. Each such stop, up to four (effort, fork, consult, switch), is sent back with the next rung in the block message.

## [0.7.0] - 2026-11-02

### Added

- Policy-auto decision records carry the route input and its outcome in `auto.replay`. `bench/route-replay.mts` replays them at no cost: exactly, or under another policy. Records still hold no prompt text.

## [0.6.1] - 2026-11-02

### Fixed

- A task on Haiku no longer leaves it at 80k tokens of context. The limit is now 150k. Fixed Haiku passed 9 of 10 screen runs past 80k, while one forced move to Sonnet raised a task from $0.12 to $0.98.

## [0.6.0] - 2026-11-02

### Changed

- Classification now sends T0 to T2 work without critical risk to Haiku, and T2 work whose need names Opus to Opus. `reachHaiku: false` restores the old rules.

### Removed

- `sonnetFirst`, added in 0.5.0. Prompt classification picks the model, so a T3 task whose need names Opus runs on Opus again.

### Fixed

- A `.sql` method in prompt text, such as `scope.expression.sql`, no longer rates a task as critical. A `.sql` file still does.

## [0.5.0] - 2026-11-01

### Added

- Route learning. AutoMode remembers, per project, which kinds of task needed rescue. After two rescues or corrections in a kind of task, with at least 40% of its recent tasks going wrong, that kind starts on Opus. Learning only raises a route, never overrides a pin, and evidence ages out after 30 days. `learning: false` turns it off.
- Delegated reads, off by default. With `delegation: on`, a full read of a large text file stops once and returns an outline with line numbers. The model can then read a range, read the whole file again, or call `extract`. `extract` asks Haiku one question, respects the person's Read permissions, and keeps a finding only if its quote is in the file at the cited lines. `shadow` records what the gate would do and changes nothing.

### Changed

- A T3 task whose need names Opus now starts on Sonnet at high effort. Only T4, a Fable verdict, T3 on critical work or an escalation requires Opus. A failed attempt still moves to Opus through the ladder. `sonnetFirst: false` restores the old rule.

## [0.4.0] - 2026-11-01

### Added

- A completion gate reads the results a request states and compares them with real command output. It reports one state: unverified, partially verified, failed or verified. `completionGate` is `report` by default, and `block` sends the model back once per task when the evidence is missing. A contradicted result counts as a failure on the escalation ladder.
- `executor: sonnet` makes Sonnet the task's model, at medium effort unless the effort judge or a floor asks for more. A pin, a floor or the escalation ladder can still move it, and effort never drops while the task's cache is warm. The judges' pick is logged as `shadowRoute`. The default stays `judge`.

## [0.3.0] - 2026-11-01

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
- An `am:` command beats a `/model` or `/effort` pin for its turn.
- `/model` and `/effort` register when they name the value the route already runs, or the app's own value. A `pin` record shows each detection.
- A model outside Haiku, Sonnet and Opus, such as Fable, passes through unrewritten and turns routing off.
- A model change in plan mode is no longer read as a pin, and an effort pin applies to helpers.
- An escalation that a pin undoes no longer claims a move.
- The Bash guard fails closed: a guard that throws before the call denies it, as every other tool guard does.
- Check detection reads through wrappers, env prefixes, virtual environments, `python3 -m` and `npx`, and it counts subagent checks and edits.
- `am:reset` also clears pins under policy `legacy`.

### Changed

- Automatic workflow entry is off by default (`autoWorkflow: false`). `am:run` still works. Decision records show what entry would have done, and `workflow-entry` records show whether a chosen workflow was called.
- The workflow result carries `next_action`, and its trace carries `effort`. `planModel` and `reviewModel` args set those models below S3. The defaults stay Opus.
- The escalation ladder takes more evidence. A first repeat, three tool errors in a row or scope growth raises the effort one step. A repeat after that raise, a test or compile regression, a revert or a reviewer blocker moves the model, with an Opus consult first.
- Sonnet xhigh is a rung of its own, below Opus high, so the ladder tries it before it moves the model.
- Critical review needs hard evidence: an edited path, an operation such as a force push or `terraform apply`, or a production target. Text or the judge alone caps at elevated, unless both agree. A judge-only critical task gets a Sonnet reviewer, and routing still reads the judge.
- A surface word such as "add a test" now covers only its own clause.

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
