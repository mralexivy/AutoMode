# Test and benchmark methodology of four Claude Code routers

Source-level audit, 2026-10-26. Every citation points into the vendored files under `bench/external/<repo>/upstream/`.
Each folder's `PROVENANCE.md` gives the commit, license and sha256 per file. No model was called for this audit.
"Inferred" marks a conclusion that the files support but do not state.

| Repo | Commit | License |
|---|---|---|
| HeyCubit/effortless | `e5c590d` | MIT, `Copyright (c) 2026 HeyCubit` |
| alexei-led/claude-router | `168334f` | MIT, `Copyright (c) 2026 Alexei Ledenev` |
| gargpratyush/jev-router | `38da6b8` | MIT, `Copyright (c) 2026 Jev Router contributors` |
| alex-jb/claude-tier-router | `795dc37` | MIT, `Copyright (c) 2026 alex-jb` |

All four are MIT. Reuse in an internal plugin is compatible if the plugin keeps each copyright line and the MIT text
with the copied files or in a notice file. `effortless` already does this (`effortless/PROVENANCE.md`). Do the same for
any fixture you copy from the other three. Fixture files are covered by the same license as the repo: none of the four
has a separate data license.

## 1. HeyCubit/effortless

**Files.** `bench_RESULTS.md`, `bench_agentic_run.sh`, `bench_agentic_score.cjs`, `bench_judge-cases.json`,
`tests_effortless.test.ts.txt` (279 `test`/`it` calls), `hooks_register.tsx` (`benchGrade` at 890-895).
The upstream tree at the pin also has `bench/hard/` (planted-bug bench), `bench/quality.mjs` with
`bench/quality-cases.json`, `bench/helpers/`, and `bench/results/*`. These are not vendored. For this audit
`bench/results/agentic-2026-10-10.json` was read from the pin into the scratchpad only.

### 1a. Judge benchmark (`/effortless bench`)

- **Dataset.** `bench_judge-cases.json`: 75 cases. 20 are `holdout`. 19 carry `context` (the last user message and the
  end of the assistant reply). Every case has `current` model and effort (67 Sonnet, 8 Opus). Kinds: answer 14,
  normal 13, trivial 11, big 8, short-but-big 7, non-code 7, follow-up 5, model-relative 5, meta 5.
- **Ground truth.** `ok` lists every effort "a careful person would accept", first is cheapest
  (`bench_judge-cases.json:2`). The effortless author wrote the labels. The holdout cases "were written before the
  judge prompts were tuned on the rest" (same line). The labels are independent of AutoMode. They are only partly
  independent of effortless: the same author wrote the judge prompt and tuned it on the other 55.
- **Baselines.** "always medium", "always high" (`bench_RESULTS.md:51-56`).
- **Grader.** `benchGrade` (`hooks_register.tsx:890-895`): hit if the effort is in `ok`, else under or over by rank.
  Unit tests at `tests_effortless.test.ts:1497-1532` show the grader can return each outcome.
- **Quality of executed task.** Not applicable: it grades the effort label only.
- **Cost.** Not measured. `bench_RESULTS.md:43` says the Haiku judge adds about $0.001 to $0.002 per prompt.
- **n x reps.** 75 x 1 per judge.
- **Limits.** `bench_RESULTS.md:49` reports "73 hand-labelled prompts (20 held out), version 1.5.1". The file at the
  pin has 75. The table is stale against its own fixture, and no judge-bench result file is in the tree, so the
  93% and 99% figures cannot be reproduced from checked-in data. The `ok` sets are generous (44 of 75 accept two
  efforts), which raises every hit rate, baselines included.

### 1b. Agentic bench (`bench/agentic/run.sh`)

- **Dataset.** Four prompts against a fresh copy of the effortless repo (`bench_agentic_run.sh:24-27`):
  t1 find a threshold and explain it, t2 add JSDoc without code changes, t3 write and run a script that counts tests,
  t4 trace the Update button flow. `bench_RESULTS.md:40` calls them "Mostly easy tasks".
- **Arms.** `m`, `h`, `x` = fixed medium, high, xhigh, plugin not loaded. `on` = medium plus the plugin
  (`bench_agentic_run.sh:29`). Both Opus 5.5 and Sonnet 5.5, `claude -p` with an API key (`:34`).
- **Ground truth.** Programmatic and independent of the router: `bench_agentic_score.cjs:22-45`. t1 regex for the
  threshold name and no changed files. t2 code lines unchanged and every export documented. t3 runs the script and
  compares with a count taken from the pristine file. t4 regex for three function names and no changed files.
- **Quality validated?** Yes, as a correctness check per task. It does not judge how good the answer is
  (`bench_RESULTS.md:41`).
- **Cost.** Measured: `total_cost_usd` from the CLI JSON (`bench_agentic_score.cjs:51`). The Haiku judge cost is not
  in it (`bench_RESULTS.md:43`), so the `on` arm is understated by about 1%.
- **n x reps.** 4 tasks x 4 arms x 2 models x 3 reps = 96 runs. All 96 were correct.
- **Where the saving came from.** The scorer records only cost, `num_turns` and time (`bench_agentic_score.cjs:51`),
  so tokens per request are not available. Cost per request is the proxy. Computed from
  `bench/results/agentic-2026-10-10.json` at the pin:

  | Model, arm | Cost/task | Requests/task | Cost/request |
  |---|---|---|---|
  | Opus medium | $0.190 | 7.25 | $0.0262 |
  | Opus high | $0.209 | 8.00 | $0.0261 |
  | Opus xhigh | $0.257 | 9.92 | $0.0259 |
  | Opus effortless | $0.149 | 5.83 | $0.0256 |
  | Sonnet medium | $0.092 | 6.42 | $0.0143 |
  | Sonnet effortless | $0.096 | 7.50 | $0.0127 |

  Cost per request is flat within about 2% on Opus across all arms. The saving therefore came from **fewer requests**,
  that is, different and shorter trajectories at low effort, not from fewer tokens per request. This agrees with
  `bench_RESULTS.md:34`. One task carries most of it: Opus t3 went from 6.3 requests and $0.208 (medium) to 3.3
  requests and $0.085 (effortless). That is $0.031 of the $0.041 per-task saving (inferred share, from the JSON).
  On Sonnet effortless made more requests than medium and cost 4% more.
- **Limits.** The judge picked the same effort in all three reps of each task (low on t1-t3, high or medium on t4),
  so the `on` arm is in effect "fixed low on three easy tasks" against fixed medium. n = 3 per cell, no confidence
  intervals. One repo, which is the plugin's own source, so the tasks may sit close to what the author tuned on.
- **Planted-bug bench.** `bench/hard/` at the pin (not vendored) defines 10 planted bugs with a test-suite oracle and
  a `verify.cjs` that checks each bug makes the suite fail. The tree has no `hard` result file, so it was not run or
  not published.

### 1c. Model-switch quality bench (`bench/quality.mjs`, not vendored)

30 prompts, one run each, blind Opus grader, against Opus medium and Opus high (`bench_RESULTS.md:60-76`). It
measured fresh chats only, and the author then turned model switching off because of cache-write cost
(`bench_RESULTS.md:78-80`). Useful as a negative result. n = 30 x 1, LLM grader.

**Mechanisms worth reusing.** Stateful cases with `current` and `context`. A holdout written before tuning.
Under/over grading. API-key-only billing guard with an empty `CLAUDE_CONFIG_DIR` (`bench_agentic_run.sh:31-33`).
Programmatic task checks that also forbid side effects (changed-file diff against a pristine copy,
`bench_agentic_score.cjs:8-9`).

## 2. alexei-led/claude-router

**Files.** `docs_evaluation.md`, `test_fixtures_mode-probe.json`, `scripts_probe-modes.mjs`,
`experiments_mod-router_results_mode-probe-jev.json`, `test_fixtures_activity-probe.json`,
`scripts_probe-activity.mjs`, `experiments_mod-router_results_activity-probe-*.json` (5),
`test_fixtures_decision-golden.json`, `test_decision-golden.test.mjs`, `experiments_mod-router_scripts_trace-eval.mjs`
with its test, `experiments_mod-router_results_trace-evaluation.json`, and 36 `test_*.test.*` files (581 `test` calls).
The project states its own limits plainly: "The native Mod has no measured savings result" (`docs_evaluation.md:3`),
"Neither result measures answer quality or proves lower real spend" (`:5`).

### 2a. Tier probe (mode probe)

- **Dataset.** 20 synthetic prompts across tier x activity cells (`test_fixtures_mode-probe.json`).
- **Ground truth.** "the tier and activity a reader would expect" (`test_fixtures_mode-probe.json:2`), written by the
  router author in the router's own tier names. Independent of AutoMode. The tier-to-band map in AutoMode
  (`ROUTER_BANDS`, `bench/lib/judge-eval.mjs:51`) is AutoMode's own.
- **Grader.** Exact match on tier and on activity (`scripts_probe-modes.mjs:142-158`).
- **Result.** Jev classifier, one run on 2026-10-21: tier 13 of 20, activity 19 of 20
  (`experiments_mod-router_results_mode-probe-jev.json:14-15`). Of the 7 tier misses, 4 were one tier too high and
  3 one tier too low.
- **Cost.** Projected: list price for a nominal 50k-input, 2k-output turn per mode (`label` and `nominalTurn` in the
  result file). Not measured.
- **Limits.** n = 20 x 1, one classifier, author labels.

### 2b. Activity probe

- **Dataset.** 70 synthetic prompts, 10 per activity, 10 with a short dialogue, "weighted to boundary cases"
  (`test_fixtures_activity-probe.json:2`, `docs_evaluation.md:91`).
- **Grader.** Exact match plus confusion matrix (`scripts_probe-activity.mjs:61-84`).
- **Result.** Jev 70/70, OpenAI 70/70, Clef 69/70, Clef Flash 69/70, Ollama 66/70, one run each
  (`docs_evaluation.md:101-107`). A test fails if the doc module and the result files disagree
  (`test_probe-results.test.mjs:11-27`).
- **Limits.** Label accuracy only, "not routing quality or savings" (`docs_evaluation.md:109`).

### 2c. Decision golden (875 scenarios)

- **Dataset.** 875 keyed scenarios (`test_fixtures_decision-golden.json`): defaults 374, mixed 405, metered 68,
  allCredits 12, decide 16. Each is a config x incumbent x advice shape x cache x context combination.
- **Ground truth.** The code's own output: "Regenerate with GOLDEN_WRITE=1 ... only for an intended decision change"
  (`test_decision-golden.test.mjs:10-12`). This is a regression snapshot. It is circular by design: it pins behavior
  across refactors and says nothing about whether a route is right.
- **Reuse.** Not as data. The mechanism (generated scenario grid plus a write flag) suits AutoMode's `policy.ts`.

### 2d. Native shadow replay (112 sessions)

- **Dataset.** One Team `decisions.jsonl` trace, 2026-09-23 to 2026-10-04: 24,408 Team rows across 112 sessions,
  11,619 main decisions, only 37 with classifier advice (`experiments_mod-router_results_trace-evaluation.json:12,32`,
  `docs_evaluation.md:29-36`).
- **Grader.** Replays each session under the legacy and the native policy, the native one at two bounds of the
  unknown cache prefix (`experiments_mod-router_scripts_trace-eval.mjs:278-331`, `:342-348`). Legacy parity: the
  replay matched the logged tier and reason on 1,704 of 1,704 replayable decisions (`trace-evaluation.json:240-243`).
- **Result.** 0 of 37 advised decisions differ between policies, so "this replay ... cannot support a savings claim"
  (`docs_evaluation.md:38`).
- **Cost.** Shadow list-price estimates for the next request only (`docs_evaluation.md:40`, `:182`).
- **Limits.** One developer's trace. The checked-in result file was committed 2026-10-05, while `trace-eval.mjs` at
  the pin dates from 2026-10-22 and writes a `modes` block (`trace-eval.mjs:540`) that the result file lacks. The
  result is stale against its script (inferred from commit dates via `gh api`).

### 2e. Other checks

A historical gateway list-price comparison (26 sessions, 1,611 requests, `docs_evaluation.md:9-23`), and one live
session where the pane's routed estimate matched the CLI's reported cost, $0.48 against $0.480
(`docs_evaluation.md:126`). That live check is the only measured-cost validation in the repo, and it validates
accounting, not savings.

**Mechanisms worth reusing.** Two-bound replay when a log lacks cache-creation tokens. A legacy-parity check that
proves the replayer reproduces logged decisions before it compares policies. A test that fails when doc numbers drift
from result files. A tool-use agreement label per turn as a free outcome proxy (`docs_evaluation.md:61-87`).

## 3. gargpratyush/jev-router

- **Files.** `test_policy.test.mjs` (14 tests), `test_proxy.test.mjs`, `test_codex.test.mjs`,
  `test_settings.test.mjs`, `test_explain.test.mjs` (65 tests in all), `test_live-routing.mjs`, `test_proxy-host.mjs`,
  `src_policy.mjs`, `src_router.mjs`, `src_config.mjs`, `src_proxy.mjs`.
- **Dataset and ground truth.** None for routing quality. `test_policy.test.mjs:18-90` checks the policy gates of
  `decide` (`src_policy.mjs:37-62`) with hand-made Jev answers: user override, low confidence never downgrades,
  capped upgrade, cache-rebuild refusal above 20k tokens, availability clamp. The proxy tests inject a stub router
  (`src_proxy.mjs:170` takes `route = askJev`).
- **Live script.** `test_live-routing.mjs:8-13` sends 4 prompts with no expected labels. It calls
  `askJev({ ..., available })` (`:15`), but `askJev` reads `models` and returns `null` when it is absent
  (`src_router.mjs:32-33`). At this commit the script prints `FAIL` for every prompt (inferred from source, not run).
- **Baseline, grader, quality, cost.** None. Thresholds (`minConfidence: 0.3`, `downgradeMaxContextTokens: 20000`,
  `src_config.mjs:48-58`) have no data behind them in the repo.
- **Reuse.** The confidence gate (low confidence never downgrades) is already in AutoMode. No fixture to import.

## 4. alex-jb/claude-tier-router

- **Files.** `docs_benchmark.md`, `scripts_benchmark_tasks.py`, `scripts_run_benchmark.py`,
  `src_tier_router_router.py`, `src_tier_router_logger.py`, `tests_test_router.py` (8 tests).
- **Dataset.** 20 single-turn prompts, 10 `structured` and 10 `reasoning` (`scripts_benchmark_tasks.py:30-158`).
  Not coding-agent tasks.
- **Ground truth.** `kind` is set by the author. The `tiered` arm routes by that same label
  (`scripts_run_benchmark.py:35-41`), not by the router's `auto()` (`src_tier_router_router.py:65-70`). The
  benchmark therefore assumes perfect routing and does not test the router.
- **Grader.** Case-insensitive substring of one keyword, `expected_signal` (`scripts_run_benchmark.py:59`). An empty
  signal counts as a hit (`scripts_benchmark_tasks.py:89`). Quality is otherwise "manual"
  (`scripts_run_benchmark.py:3-5`).
- **Cost.** Would be computed from API usage at hard-coded rates (`src_tier_router_logger.py:8-11`: Haiku 4.5 at
  $0.80/$4.00). Anthropic's list price for Haiku 4.5 is $1/$5 per MTok as far as I know; this is from general
  knowledge, not from a source in this audit.
- **Never run.** The script writes `docs/benchmark_results.jsonl` and `docs/benchmark_summary.json`
  (`scripts_run_benchmark.py:32`, `:144`). Neither exists in the tree at the pin. The table is "Back-of-envelope"
  and "a template" (`docs_benchmark.md:50`, `:61`).
- **Table contradicts its own price ratio.** At equal tokens Sonnet costs 3.75x Haiku (`README.md:17-20`). With the
  doc's own token assumptions (`docs_benchmark.md:50`) and rates (`:29-32`), the three arms cost $0.034, $0.126 and
  $0.097: a 3.75x ratio, and tiered 23% below Sonnet-only. The table says $0.012, $0.095, $0.055, "~8x", and
  "~40% lower" (`docs_benchmark.md:54-59`). The README's "~10x" (`README.md:7`, `:30`) comes from an unrelated
  trading agent.
- **Unit tests.** Mock client; they check model IDs and cost arithmetic only (`tests_test_router.py:13-84`).

## Comparison

| Repo | Dataset | Ground truth | Baseline | Grader | Quality validated? | Cost measured? | n x reps | Main bias |
|---|---|---|---|---|---|---|---|---|
| effortless judge | 75 stateful prompts (20 holdout) | Author labels, `ok` sets | always medium, always high | `benchGrade` set membership | n/a (label only) | No | 75 x 1 | Same author labels and tunes; stale 73-case table |
| effortless agentic | 4 easy repo tasks | Programmatic checks | fixed medium, high, xhigh | `score.cjs:22-45` | Yes, correctness | Yes, CLI cost | 4 x 4 arms x 2 models x 3 = 96 | Easy tasks; one task drives the saving |
| claude-router mode probe | 20 synthetic prompts | Author labels | none | exact tier/activity | No | Projected | 20 x 1 | Author labels, one classifier |
| claude-router activity probe | 70 synthetic prompts | Author labels | 5 classifiers compared | exact + confusion | No | No | 70 x 1 per classifier | Synthetic, label only |
| claude-router golden | 875 scenarios | Code's own output | n/a | deep equal | No | No | 875 x 1 | Circular by design |
| claude-router replay | 112 sessions, 37 advised | Logged decisions | legacy policy | parity + diff | No | Shadow estimate | 37 decisions | 0 differences; stale result |
| jev-router | none | none | none | policy unit tests | No | No | 0 | No evaluation |
| claude-tier-router | 20 single-turn prompts | `kind` label = routing oracle | Haiku-only, Sonnet-only | keyword substring | No | Would be measured; never run | 20 x 1 (planned) | Never run; table inconsistent |

## Import list

Already imported into AutoMode: effortless `judge-cases.json` (source `effortless`, `bench/lib/judge-eval.mjs:48`)
and claude-router `mode-probe.json` (source `router`, `bench/lib/judge-eval.mjs:51`).

| Priority | Fixture | Labels independent of AutoMode? | Adapter needed |
|---|---|---|---|
| 1 | effortless `bench/hard/tasks.json` with `plant.cjs`, `verify.cjs`, `score.cjs` (not vendored yet) | Yes: the repo's own test suite is the oracle | Fetch into `effortless/upstream/` and add rows to `effortless/PROVENANCE.md`. Write a converter to the `bench/tasks/*.json` format and run `bench/validate-fixture.mjs`-style checks (suite fails with the bug, passes without). Needs an effortless checkout at the pin as workspace. Paid to run. |
| 2 | `claude-router/upstream/test_fixtures_activity-probe.json` (70, 10 with dialogue) | Yes | New `source: 'router-activity'` in `bench/lib/judge-eval.mjs`. Map `dialogue` to `lastReply` with the existing `lastAssistant`. AutoMode has no activity label, so add an `accept.writes` field: `code`, `debug`, `ops`, `docs` = writes; `explore`, `review`, `plan` = no writes. Score it against the consequence and risk detectors, whose rule is "a domain AND a change". The boundary pairs ("fix the deploy script" against "deploy the fix") test exactly that. |
| 3 | effortless agentic prompts and checks (`effortless/upstream/bench_agentic_run.sh:24-27`, `bench_agentic_score.cjs:22-45`) | Yes, programmatic | Port the four checks into a grader for `bench/run.mjs`. Keep the effortless checkout at the pin. Record requests per task and cost per request so a saving can be split into trajectory and per-request parts. |

Do not import as ground truth: claude-router `decision-golden.json` (circular, other taxonomy), claude-tier-router
`benchmark_tasks.py` (keyword grader, `kind` is the oracle), jev-router `test_live-routing.mjs` (no labels, broken
call).

## Claims in our docs

Sources of the claims: `the router comparison:8,26` and `docs/automode-auto.md:45`.

| Claim | Verdict | Evidence |
|---|---|---|
| claude-router: 20 tier probes, 13 of 20 correct | Verified | `test_fixtures_mode-probe.json` has 20; `mode-probe-jev.json:14` tierMatches 13. One Jev run, author labels. |
| claude-router: 875 policy scenarios | Verified, with a caveat | 875 keys in `test_fixtures_decision-golden.json`. They are a regression snapshot of the router's own output, not labeled scenarios. |
| claude-router: 112-session shadow replay | Verified, with a caveat | `trace-evaluation.json:12`. Only 37 advised decisions, 0 differences, result older than its script. |
| jev-router: evaluation "None" | Verified | No labeled data, results or benchmark. The only live script has no labels and returns `null` at the pin. |
| claude-tier-router: benchmark described and never run | Verified | No result files in the tree; doc calls the table "Back-of-envelope" and "a template". |
| claude-tier-router: table contradicts its own price ratio | Verified | 3.75x by its own rates and tokens against "~8x" in the table. |
| effortless: 75 stateful labeled cases | Verified, with a caveat | 75 cases, all with `current` state, 19 with `context`. Upstream's own RESULTS table still reports 73. |
| effortless: 96-run agentic bench on 4 easy tasks | Verified | `bench_RESULTS.md:9,40`; `agentic-2026-10-10.md` lists 96 runs. |
