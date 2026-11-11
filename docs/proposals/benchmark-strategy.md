# Benchmark strategy: external quality and cost evidence for AutoMode

Status: proposal. This is a research report and a blueprint. It runs no benchmark and changes no code.

- Repository revision: `b20350c`. Plugin version: `0.10.0`.
- Research date: 2026-11-11.
- Source checks: official repositories, read through the GitHub API on 2026-11-11.

Each statement carries one of three labels:

- **Verified**: checked in code at `b20350c` or in an official source, with a reference.
- **Unverified**: not confirmed. It is never used to size a budget.
- **Recommendation**: a design choice, not a fact.

Each cost figure carries one of five labels:

- **AutoMode-measured**: rows in `bench/results/`.
- **Third-party published**: a leaderboard or a repository result.
- **Price estimate**: list price × an assumed token count.
- **Illustrative**: a planning number with no measurement behind it.
- **Zero paid inference**: no model is billed, though local compute still costs something.

## Contents

- [A. Verdict and executive findings](#a-verdict-and-executive-findings)
- [B. AutoMode architecture and benchmark audit](#b-automode-architecture-and-benchmark-audit)
- [C. External benchmark landscape](#c-external-benchmark-landscape)
- [D and L. Minimal credible portfolio](#d-and-l-minimal-credible-portfolio)
- [E and N. Quality and cost standard, statistical power](#e-and-n-quality-and-cost-standard-statistical-power)
- [F and G. Integration architecture and experimental protocol](#f-and-g-integration-architecture-and-experimental-protocol)
- [K. Cost-aware evaluation architecture](#k-cost-aware-evaluation-architecture)
- [M and O. Progressive protocol and cost forecast](#m-and-o-progressive-protocol-and-cost-forecast)
- [Benchmark gaming and low-quality patches](#benchmark-gaming-and-low-quality-patches)
- [H and P. Public evidence and claim readiness](#h-and-p-public-evidence-and-claim-readiness)
- [I and Q. Roadmap and acceptance criteria](#i-and-q-roadmap-and-acceptance-criteria)
- [Risks](#risks)
- [J. Implementation prompt for Stages 0 and 1](#j-implementation-prompt-for-stages-0-and-1)

## A. Verdict and executive findings

**Review verdict.** The review approved the direction and rejected the spending plan.

What changed after review:

| Item | Original plan | Revised plan |
|---|---|---|
| Spending | Full suites first | A five-stage funnel. Stage 0 needs no paid inference. Every paid stage needs an approved ceiling. |
| Arms | Large matrix | AutoMode default against fixed Sonnet High. Other arms only for a stated question. |
| Repeats | 3 by default | 1. More only when the power table justifies them. |
| Margin | Blanket 3-point non-inferiority | A power table first. The claim is narrowed when the budget cannot support the margin. |
| Portfolio | Broad | Two P0 suites, two P1 tracks. Everything else is deferred. |
| DeepSWE | Harbor | Pier, its own runner. |
| Budget cap | Described as hard | Five layers, with the residual overrun risks stated. |

**Findings.**

1. **No external benchmark result exists for AutoMode.** Adapters exist: `bench/datasets/swebench.mts`, `bench/datasets/terminal-bench.mts` and `bench/datasets/codegen.mts`. `bench/results/` holds no rows from any of them (Verified).
2. **On single coding tasks, the internal evidence favors fixed Sonnet High.**
   - S2, 30 tasks: Sonnet High passed 30/30 at $0.240 per pass. AutoMode v6c passed 29/30 at $0.275 per pass. Opus passed 28/30 at $0.499 (`bench/experiments/V6.md:163-167`, AutoMode-measured).
   - On the 20-step mixed sessions, AutoMode cost $2.01 and Sonnet High $2.14. Each ran once, with no CI. AutoMode's rows are from W2 and Sonnet High's from the earlier W1 (`bench/results/headline.json`).
   - So the primary external question is whether AutoMode beats fixed Sonnet High. Beating Opus is not the question.
3. **Two external suites form the smallest credible core:**
   - Terminal-Bench 4.1: agentic terminal work, run through Harbor.
   - SWE-bench Pro V2: repository-level patches with pristine re-grading, also through Harbor.
   - Both have official verifiers, network isolation and a Claude Code agent path.
   - DeepSWE v1.1, run through Pier, is the P1 confirmation.
4. **External trials likely cost about 50 to 80 times more than internal ones (Illustrative).**
   - Published Terminal-Bench 4.0 leaderboard totals for Claude Code give about $14.30 per trial for Opus 5.5 at max effort, and about $22.22 for Sonnet 5.5 at max (third-party published, divided by 330 trials).
   - AutoMode's internal S2 trials cost about $0.275 per pass (AutoMode-measured).
   - The ratio compares different models, efforts and units (per trial against per pass). It is a planning signal, not a measurement.
   - Internal costs cannot forecast external ones. Stage 1 must measure them.
5. **No affordable sample supports a 3-point non-inferiority claim** (section N). Paired at 50 tasks with 1 repeat, the 95% CI on the pass-rate difference is about ±8 to ±18 points.
   - In the near term, the defensible outputs are a cost-ratio estimate with a CI beside a descriptive quality comparison.
   - A 10-point margin becomes feasible only near 100 to 200 paired tasks.
6. **Harbor's `claude-code` agent cannot pass `--plugin-dir`.** Loading AutoMode needs one of three routes: a settings file, a prebuilt image, or a thin agent subclass. The route must be proven on the real CLI before anything is built on it (section F).

## B. AutoMode architecture and benchmark audit

### Routing as implemented (Verified, `b20350c`)

**Entry and decision.** `v4PromptSubmit` (`hooks/v4.ts:1554`) calls `decide` (`hooks/v4.ts:635`), which calls `decideAuto` under policy `auto` (`hooks/v4.ts:946`).

**Judges.** Two Haiku judges run in parallel (`hooks/v4.ts:1004`):
- The AutoMode judge (`hooks/v4.ts:538`; contract in `hooks/lib/classify.ts:101`).
- The effortless judge (`hooks/v4.ts:811`; `hooks/lib/effortless.ts:200`).

**Pure route.** `planAuto` and `routeAuto` (`hooks/lib/auto-route.ts:197,297`) build the route.
- Floors: `autoFloors` (`hooks/lib/auto-route.ts:140`).
- Fallbacks when a judge fails (`hooks/lib/auto-route.ts:209-269`).
- A low-confidence guard below 0.3 (`hooks/lib/auto-route.ts:273`).
- Learned exclusions (`hooks/lib/auto-route.ts:280`).

**Candidate choice.** `optimizeAuto` (`hooks/lib/auto.ts:175`) picks the cheapest eligible non-Opus candidate by `attemptUsd`. Opus runs only when nothing weaker is eligible (`hooks/lib/auto.ts:198-201`).
- Under a v6 start, Haiku is eligible only through `v6HaikuStart` (`hooks/lib/auto.ts:123`; `hooks/lib/execution.ts:41`).

**Authority.** `resolve` (`hooks/lib/authority.ts:61`) applies this order: user override, floor lift, then `switchCheck` (`hooks/lib/policy.ts:163`).
- A downgrade passes only on a payback rule (`hooks/lib/policy.ts:248-257`).
- Cache rebuild cost is priced in `hooks/lib/policy.ts:77-109`.

**Prices.** `hooks/lib/prices.ts:14`, checked 2026-10-17.
- Cache writes cost 1.25× for 5-minute entries and 2× for 1-hour entries (`hooks/lib/prices.ts:43`).
- Haiku is priced 5× above 100k prompt tokens.

**Escalation.** `escalation()` (`hooks/lib/failures.ts:264`) grades the failure evidence. Then:
- `runLadder` (`hooks/v4.ts:2241`) steps effort or model.
- `v6Recover` (`hooks/v4.ts:2146`) runs the rescue under v6.

**Shipped config.** `config.json` sets `strategy: "v6c"`, `reachHaiku: true`, `learning: true` and `delegation: "off"`.

### Knobs a benchmark could ablate

| Knob | Effect under shipped `v6c` | Reference |
|---|---|---|
| `routeModels: false` | Routes effort only | settings |
| `executor: sonnet` | Fixes the model to Sonnet; the judges become a shadow route | `hooks/lib/auto-route.ts:187` |
| `strategy: legacy` | Restores the legacy start and recovery | `hooks/lib/execution.ts:25` |
| `learning: false` | Turns off learned exclusions | `hooks/lib/auto-route.ts:280` |
| `AUTOMODE_GUARDIAN=off` | Turns off the guardian | `hooks/guardian.ts:134` |
| `reachHaiku`, `opusStart` | **Inert** under a v6 start | `hooks/lib/auto.ts:100,123` |
| `forkRung`, `consult` | **Inert** under v6 recovery | `hooks/v4.ts:2300` |
| Judges off, floors off | **No switch exists** | — |

Any future ablation of the judges or the floors needs a new switch with its own test. That work belongs to the implementation phase (Recommendation).

### Existing evaluation assets (Verified)

**Tasks.** `bench/tasks/*.json` holds 86 tasks: real commits with pinned base and reference SHAs.
- Hidden tests are copied in only after the diff is saved (`bench/lib/run-one.mts`).
- `bench/fixture-check.mts` drops one reference hunk at a time and confirms the tests catch it.

**Mixed sessions.** `bench/experiments/sessions/v6-w2-release.json` and its siblings: 5 repos × 4 steps.
- Questions are graded by regex.
- Tasks are graded by hidden tests.

**Budget and run control:**
- `bench/lib/admission.mts:31` admits a run when spent + in-flight + next ≤ budget.
- `bench/lib/ledger.mts`: append-only ledger.
- `bench/lib/pacer.mts`: usage-window pacing.
- `bench/lib/plan.mts`: run plan.
- `bench/lib/identity.mts`: immutable run ids that hash task, arm, behavior files, template and repeat.
- `bench/run.mts`: `--reuse-from`, a contamination stop, a machine lock and a preflight hash.

**Statistics:**
- `bench/lib/stats.mts`: a task-then-repeat bootstrap, `pairedDelta`, `mcnemarExact`, `holm`, a Pareto frontier.
- `bench/lib/decide.mts` and `bench/experiments/policies/*.json`: preregistered SHIP rules.
- `bench/experiments/PREREGISTERED.md`.

**External competitors.** Upstream effortless runs live at pinned SHA `e5c590d` (`bench/arms.mts`). The other vendored routers were audited only (`bench/external/METHODOLOGY.md`).

### Weaknesses in the current evidence (Verified)

- **Tuning on the test set.**
  - The session arm ran five times on the same sessions, with code fixed between runs. Only W2 is published.
  - S2 re-ran the S1 tasks after fixes found on those tasks (`bench/experiments/V6.md`, Results and Limits).
- **Outcome-informed selection.** The 30 proof tasks include 4 chosen because they had failed before (`bench/experiments/rescue-confirm.json`).
- **Small samples, single runs, a ceiling effect.** The headline compares 20 steps, run once, and every arm passed all 20. So the headline measures cost only.
- **Arms never interleaved.** Session arms ran one after another (W1: Opus 08:29, Sonnet 08:50, AutoMode 09:06).
- **Controls reused across revisions.** S2's Opus rows come from S1. Its Sonnet High rows come from v5 (`bench/experiments/V6.md:169-171`). The headline's Sonnet High and Opus totals come from W1, an earlier run than AutoMode's W2.
- **Incomplete judge cost.** The CLI total leaves out the hook judges (`bench/experiments/V6.md:63`). They are added only for v4 arms (`bench/e5-sessions.mts:149`). The effortless arm's Haiku judge is recorded as $0.
- **Unpinned and outdated external version.** The Terminal-Bench catalogue entry has revision "harbor registry", which floats (`bench/datasets/catalog.mts:22`). The adapter runs `terminal-bench/terminal-bench-2`, so it points at Terminal-Bench 2, not 4.1 (`bench/datasets/terminal-bench.mts:5`).
- **Reservation uses the expected cost.** In-flight runs reserve `expectedUsd`, a historical mean capped at `run_cap_usd`, not the cap itself (`bench/run.mts:157-161`; `bench/lib/admission.mts:14-20`). Parallel runs can therefore commit more than the budget.
- **Host-side runs.** The `claude -p` track runs on the host with network access. Leakage is scanned for after the run, not prevented.

### Reuse, extend, leave alone (Recommendation)

- **Reuse unchanged:**
  - `bench/lib/stats.mts`, `bench/lib/decide.mts`, `bench/report.mts`, `bench/proof-report.mts`
  - `bench/lib/ledger.mts`, `bench/lib/identity.mts`, `bench/lib/manifest.mts`, `bench/verify-manifest.mts`
  - `v4JudgeCost` (`bench/lib/run-one.mts`)
- **Extend:**
  - `bench/lib/admission.mts`: cap-based reservation and an approval gate.
  - `bench/lib/plan.mts`: dry-run cost scenarios.
  - `bench/datasets/terminal-bench.mts`: generalize into a Harbor adapter.
  - `bench/datasets/catalog.mts`: pins.
- **Leave alone:**
  - `hooks/`, `workflows/` and `bench/external/`.
  - Every historical file in `bench/results/`.
  - The internal suites.

## C. External benchmark landscape

All entries were checked 2026-11-11.

| Benchmark | Version, immutable ref | Tasks | Runner | Licence | Cost data | Role for AutoMode |
|---|---|---|---|---|---|---|
| Terminal-Bench | v4.1.0, tag `4070d6c`, published 2026-11-03; Hub dataset version 5 | 66 full; **63 CPU-only** (`terminal-bench/terminal-bench-cpu@4.1.0`) | Harbor | Apache-2.0, repo-wide | Leaderboard schema requires `total_cost_usd` and tokens | **P0** |
| Harbor | v0.25.0 (2026-10-25); main `500af91` | — | `harbor run` | Apache-2.0 | `cost_usd` and tokens per trial | Shared runner |
| SWE-bench Pro V2 | v2.0.0, `66f9276`, 2026-09-22; HF `ScaleAI/SWE-bench_Pro` @ `2d52cb3` | 642 public, 11 repos; **HARD-51** (`v2/hard51_ids.txt`) | Harbor (`locked_claude_code`, then `patch_replay`) | Repo MIT; HF dataset licence Unverified | None published | **P0** |
| DeepSWE | "v1.1" is a README label; the only git tag is v1.0.0; HEAD `0b9fabb` | 113, in 5 languages | **Pier** | Apache-2.0 (Datacurve parts) | Site shows average $ per task | **P1** |
| FrontierHarness Eval | v1, frozen; `e837a70` | 30 = 21 Terminal-Bench **2.1** + 9 DeepSWE | Runta VMs plus Harbor or Pier | **None declared** | `effective_cost_per_pass` | **P1**, methodology track |
| SWE-bench Verified | 500 tasks, 2024 | 500 | `swebench` | MIT harness | — | Reject for claims: OpenAI reportedly stopped reporting it, citing flawed tests and contamination (Unverified primary: secondary coverage of an OpenAI post dated 2026-02-23) |
| SWE-bench Multilingual | 300 tasks, 9 languages | 300 | `swebench` | MIT harness | — | Deferred; the adapter exists |
| SWE-rebench | Rolling window, 2026-05-15 to 07-01 | 111 | Unverified | Unverified | Cost column | Deferred: possible contamination control |
| SWE Atlas | Q&A, test-writing, refactoring (Scale, 2026) | 284 | Harbor (Q&A) | Unverified | Unverified | Deferred: question-shaped work |
| Aider Polyglot | 225 exercises | 225 | `aider` | Unverified | Cost column | Reject: the harness is fixed and the tasks are exercises |
| LiveCodeBench, RepoBench | — | — | Not agentic | — | — | Reject: they do not exercise routing in an agent |
| HAL (Princeton) | Archived | — | — | — | Pareto frontier | Methodology reference only |
| RouterBench, RouterEval | — | — | Not agentic | — | — | Reject for claims; reference only |
| SWE-Lancer | Archived 2025-07-18 | — | — | — | — | Reject |

### What the sources say (Verified unless marked)

**Terminal-Bench 4.1:**
- 4.1 hardened the verifiers with RewardKit `Worker`. Regrading changed 162 of 11,550 trials (https://www.tbench.ai/news/terminal-bench-4-1).
- The 4.0 timeout is a flat 8 hours (https://www.tbench.ai/news/terminal-bench-4-0).
- Leaderboard inference across all 4.0 submissions totalled about $116k. That is the sum of every submission, not the cost of one run.
- Claude Code submissions in `leaderboard/submissions/` (third-party published):

  | Submission | Passed | Total cost | Avg trial |
  |---|---|---|---|
  | Opus 5.5 at max effort, CC 2.1.284 | 214/330 | $4,718.65 | 4,790 s |
  | Sonnet 5.5 at max effort | 204/330 | $7,333.64 | 7,432 s |

- No per-trial cost is published. The per-trial figures in this report divide each total by 330.
- Each row is 66 tasks × 5 trials.

**Harbor `claude-code` agent** (`src/harbor/agents/installed/claude_code.py` @ `500af91`):
- It runs `claude --verbose --output-format=stream-json [--settings …] [options] --print`.
- Options: `--max-turns`, `--effort`, `--max-budget-usd`, `--fallback-model`, `--allowedTools` and `--disallowedTools`. The permission mode defaults to `bypassPermissions`.
- Agent options forbid extra fields, so arbitrary flags such as `--plugin-dir` cannot be passed.
- A settings file can be given through `config`.
- The Claude Code `version` can be pinned, and `skip_install` is supported.
- Cost comes from `total_cost_usd` in the final result line, with a LiteLLM price fallback.
- A custom agent is passed as `--agent module.path:ClassName`.

**SWE-bench Pro V2:**
- Each task sets `network_mode = "no-network"`.
- The release gate: the oracle resolves 642/642, and the no-op agent resolves 0.
- The official run uses Modal: `-e modal` with the agent `locked_claude_code:LockedClaudeCode`. Re-grading uses `patch_replay:PatchReplayAgent` on a pristine image.
- Budget: 50 minutes per task.
- HARD-51 holds tasks that at least 2 of 5 model families failed. It is a hard slice, not a sample of the suite.
- Background, from secondary coverage of an OpenAI post dated 2026-07-08 (Unverified primary): OpenAI found about 30% of Pro v1 tasks broken. V2 is Scale's corrected release.

**DeepSWE and Pier:**
- Pier is a declared fork of Harbor that reads Harbor tasks and supports a `claude-code` agent.
- DeepSWE grading uses `[verifier] environment_mode = "separate"` and needs Pier newer than 0.3.0.
- A collect hook saves `git diff --binary` as the patch, which is graded in a pristine container.
- Agent and verifier both run with no network.
- Agent timeout: 10,800 s.
- All published scores come from mini-swe-agent. No Claude Code DeepSWE result is published.

**FrontierHarness:**
- It compares 12 harness configurations on one model, Kimi K3.
- Its Claude Code row is Claude Code driving Kimi K3: 19/30 passed, $18.34 effective cost per pass.
- Its cost metric is `effective_cost_per_pass`: every first-cold cost, failures included, divided by passes, reported with its coverage.
- The `*_normalized` fields depend on data that is not public.
- Reproducing the published numbers needs a Runta account. The task definitions themselves come from Apache-licensed upstreams.

## D and L. Minimal credible portfolio

| Priority | Benchmark | What only it adds | Why it is not redundant |
|---|---|---|---|
| **P0** | Terminal-Bench 4.1, CPU-only 63 first | Long, tool-heavy agent work with an official cost field. Anthropic cites this benchmark. | The internal suite has no terminal or ops work and no long-horizon tasks. |
| **P0** | SWE-bench Pro V2, a stratified public sample | Repository patches in 11 repos, graded by pristine patch replay with no network | The internal tasks are smaller and were tuned on. Pro V2 is independent and corrected. |
| **P1** | DeepSWE (Pier) | 5 languages, long-horizon work, a separate grader | It confirms generalization beyond Pro's repositories. |
| **P1** | FrontierHarness, as a methodology track | A cost-per-pass definition plus a harness comparison | Its tasks overlap with Terminal-Bench (2.1) and DeepSWE. Overlapping tasks are deduplicated and never counted as independent evidence. Its numbers are never AutoMode evidence. |
| Keep | Internal suites | Routing, switch economics, cache, sessions, escalation, safety floors, judge overhead | External suites run one task per session and never test session continuity. |

Two rules apply to these suites:

- **Subsets are separate distributions.** CPU-only and HARD-51 are official subsets. Each is reported under its own name. Neither stands in for its full suite.
- **No growth without a gap.** Every benchmark in the deferred rows of section C waits until a stated gap justifies its cost.

## E and N. Quality and cost standard, statistical power

### Metrics (Recommendation)

Per arm and benchmark, always reported together:

1. Verified resolved rate, and the paired difference against Sonnet High with a 95% CI.
2. Cost per attempted task: API list equivalent, with judges and every model included.
3. Cost per verified success, equal to all attempt costs divided by passes. This is FrontierHarness's `effective_cost_per_pass` and follows Kapoor et al. 2024 (https://arxiv.org/abs/2407.01502).
4. Paired cost ratio with a 95% CI, from a task-then-repeat bootstrap (`bench/lib/stats.mts`).
5. Wall time per trial.
6. Rates of budget exhaustion, timeout and `infra_invalid`.
7. A Pareto plot of pass rate against cost per attempted task.

Every failed, cut-off or capped attempt stays in the cost. Escalations and rescues are already inside the CLI's `total_cost_usd`. The hook judges are not, so they must be added (section F).

### Why cost per success alone misleads

Take 100 tasks:

| Arm | Passes | Cost per attempt | Cost per pass |
|---|---|---|---|
| A | 50 | $5 | $10.00 |
| B | 90 | $10 | $11.11 |

A is "cheaper per success", yet it fails 40 more tasks, and each failure costs a person time. So no single combined score is used. Quality and cost are two axes, and an arm wins only if it is not worse on quality beyond the margin **and** cheaper.

### Claim rule (Recommendation)

The primary claim is a joint test, and both parts must hold:

- **(i) Non-inferiority.** The lower bound of the 95% CI on the pass-rate difference (AutoMode minus Sonnet High) is above −M. M is fixed before the run.
- **(ii) Cost.** The upper bound of the 95% CI on the cost ratio is below 1.

This is an intersection–union test, so it needs no multiplicity correction. Each part uses a two-sided 95% CI, so each one-sided test runs at 2.5%. If AutoMode is also compared with Opus, Haiku or effortless as a confirmatory claim, Holm correction applies to those extra claims. Exploratory comparisons are labelled exploratory.

### Power and precision (simulation)

**Model.**
- Each task has a latent pass probability q ~ Beta with mean p and concentration k.
- Both arms share q, and the true difference is 0.
- Each run passes with probability q. A task scores the mean of r runs.
- The CI is a paired t interval on the per-task differences.
- **Precision** is the mean CI half-width.
- **Power** is P(lower bound > −M) when the arms are truly equal.
- 3,000 simulations per cell, seed 20261111, computed with a throwaway script for this report.

The k=1 rows model heterogeneous tasks; the k=4 rows model more coin-flip runs. Each cell shows `±half-width (points) · power at M = 3 / 5 / 10`:

| base p | k | repeats | discordance (r=1) | n=10 | n=30 | n=50 | n=100 | n=200 |
|---|---|---|---|---|---|---|---|---|
| 0.5 | 1 | 1 | 0.25 | ±33.2 · 0.08/0.11/0.11 | ±18.4 · 0.06/0.08/0.18 | ±14.1 · 0.07/0.11/0.27 | ±9.9 · 0.08/0.17/0.51 | ±7.0 · 0.14/0.30/0.81 |
| 0.5 | 1 | 2 | — | ±23.9 · 0.06/0.06/0.16 | ±13.0 · 0.08/0.12/0.37 | ±9.9 · 0.09/0.17/0.51 | ±7.0 · 0.13/0.28/0.80 | ±4.9 · 0.22/0.52/0.98 |
| 0.5 | 4 | 1 | 0.40 | ±44.3 · 0.03/0.05/0.05 | ±23.5 · 0.04/0.06/0.12 | ±17.9 · 0.06/0.09/0.19 | ±12.5 · 0.07/0.12/0.35 | ±8.8 · 0.10/0.20/0.60 |
| 0.5 | 4 | 2 | — | ±31.0 · 0.04/0.05/0.10 | ±16.6 · 0.06/0.09/0.22 | ±12.7 · 0.06/0.12/0.35 | ±8.8 · 0.11/0.21/0.60 | ±6.2 · 0.16/0.36/0.88 |
| 0.7 | 1 | 1 | 0.21 | ±30.1 · 0.11/0.14/0.14 | ±16.8 · 0.06/0.07/0.21 | ±12.9 · 0.06/0.13/0.33 | ±9.0 · 0.09/0.20/0.60 | ±6.4 · 0.16/0.35/0.87 |
| 0.7 | 1 | 2 | — | ±21.7 · 0.07/0.07/0.20 | ±11.8 · 0.07/0.12/0.41 | ±9.2 · 0.10/0.19/0.58 | ±6.4 · 0.15/0.33/0.87 | ±4.5 · 0.26/0.56/0.99 |
| 0.7 | 4 | 1 | 0.34 | ±40.1 · 0.04/0.06/0.06 | ±21.6 · 0.05/0.06/0.13 | ±16.4 · 0.05/0.09/0.23 | ±11.5 · 0.08/0.14/0.39 | ±8.1 · 0.11/0.23/0.67 |
| 0.7 | 4 | 2 | — | ±28.4 · 0.05/0.05/0.12 | ±15.2 · 0.06/0.09/0.26 | ±11.6 · 0.08/0.14/0.39 | ±8.1 · 0.10/0.22/0.68 | ±5.7 · 0.18/0.39/0.93 |
| 0.9 | 1 | 1 | 0.09 | ±17.0 · 0.37/0.38/0.38 | ±10.3 · 0.18/0.28/0.54 | ±8.2 · 0.16/0.23/0.71 | ±5.9 · 0.20/0.44/0.90 | ±4.2 · 0.30/0.65/1.00 |
| 0.9 | 1 | 2 | — | ±12.3 · 0.26/0.26/0.47 | ±7.5 · 0.14/0.30/0.69 | ±5.9 · 0.21/0.43/0.87 | ±4.2 · 0.32/0.66/0.99 | ±2.9 · 0.50/0.90/1.00 |
| 0.9 | 4 | 1 | 0.14 | ±23.4 · 0.22/0.23/0.23 | ±13.8 · 0.10/0.12/0.34 | ±10.6 · 0.09/0.16/0.49 | ±7.5 · 0.13/0.27/0.73 | ±5.3 · 0.19/0.45/0.96 |
| 0.9 | 4 | 2 | — | ±17.4 · 0.11/0.11/0.29 | ±9.8 · 0.11/0.19/0.55 | ±7.5 · 0.13/0.26/0.73 | ±5.3 · 0.20/0.47/0.96 | ±3.7 · 0.35/0.75/1.00 |

The n=10 column is unreliable. Many samples have no discordant task, so the t interval collapses to zero width, and the "power" there is an artifact. Treat n=10 as descriptive only.

**Reading the table.**

| Paired tasks | What it can support |
|---|---|
| 10 | Descriptive only: did it run, what did it cost, which tasks split. |
| 30 to 50 | Likely a usable cost-ratio CI, because costs are continuous and paired (Recommendation: the table models pass rate only, so Stage 2 must check this). Quality is descriptive: with 1 repeat, the CI is about ±8 to ±24 points. At most a "no loss larger than about 15 points" statement. |
| 100 | A 10-point margin at power 0.35 to 0.99, depending on p, k and repeats. |
| 200 | A 10-point margin at power ≥ 0.6, and a 5-point margin only at high p with 2 repeats. |
| 3 points | Out of reach at any size in this table (power ≤ 0.5). |

Two consequences follow:

- **The 63-task ceiling.** Terminal-Bench CPU-only has only 63 tasks. With published Claude Code pass rates near 0.62 to 0.65 (full 66-task suite, max effort; the CPU-only rate is Unverified), it alone can never support a tight margin. A confirmatory quality claim needs the two P0 suites pooled, with the pooling preregistered.
- **Sequential designs are not recommended (Recommendation, not simulated).** A group-sequential design stops early mainly when the true effect is large. For a non-inferiority question near equality, it rarely stops early, so its expected saving is small. Revisit it at Stage 4.

**If the budget cannot reach the margin.** M is not loosened after the fact. The report instead states:
- the precision achieved;
- the narrower claim the data supports, for example "cost ratio X (CI); pass-rate difference Y (CI), inconclusive at M";
- the sample size the stronger claim would need.

## F and G. Integration architecture and experimental protocol

### Components (Recommendation)

```
experiment manifest (bench/experiments/*.json, extended fields)
        │ dry-run plan + approval (bench/lib/plan.mts, bench/lib/admission.mts)
        ▼
runner selection ── Harbor: Terminal-Bench 4.1, SWE-bench Pro V2
                └── Pier:   DeepSWE
        │ shared AutoMode agent config (arm → model, effort, plugin, config overlay from bench/arms.mts)
        ▼
official verifier (unchanged) ──► trial JSON + Claude Code session logs
        │ normaliser: bench/lib/harbor-trial.mts → existing row schema
        ▼
ledger (bench/lib/ledger.mts) → stats/decide/report (unchanged) → manifest (bench/lib/manifest.mts)
```

- **Shared:**
  - Arm definitions in `bench/arms.mts`, so the external track reuses the same arm ids.
  - The row schema: `run_id`, `task_id`, `arm`, `repeat`, `accepted`, `cost_usd_api_equiv`, `judge`, `model_usage`, `wall_s`, `budget_exhausted`, `infra_invalid`.
  - The ledger and the statistics.
- **Generic Harbor adapter.** `bench/datasets/harbor.mts` generalizes `bench/datasets/terminal-bench.mts`.
  - It pins `dataset@version` and records the git tag SHA.
  - It validates the trial schema against a real oracle trial. The existing README says this was never checked.
- **Pier adapter.** `bench/datasets/pier.mts` is a thin wrapper around `pier run`.
  - It keeps `environment_mode = "separate"`, the collect hook and the no-network setting exactly as upstream ships them.
  - It does not treat Pier and Harbor as interchangeable. Each gets its own contract test against a real oracle trial.
- **Plugin loading.** Try the routes in this order, and stop at the first that passes the acceptance test:
  1. **Settings route.** Pass Harbor's `config` settings with `extraKnownMarketplaces` (a directory source) and `enabledPlugins`. The repo ships `.claude-plugin/marketplace.json`. Open question (Unverified): can the plugin tree reach the container without a custom install step?
  2. **Image route.** Use `skip_install` with a prebuilt image that has a pinned Claude Code and the plugin tree baked in, enabled through the same settings.
  3. **Thin agent subclass.** Subclass Harbor's `ClaudeCode`, or Pro V2's `LockedClaudeCode` to keep its locked tools, and only add `--plugin-dir` plus the upload. The installed CLI (2.1.308) lists `--plugin-dir` and `--plugin-url` in `claude --help`, run locally on 2026-11-11.

  **Acceptance test:** a trial's session logs contain AutoMode decision records, and the `sonnet-high` control trial contains none.
- **Judge cost.** Read the AutoMode hook records from Harbor's saved `CLAUDE_CONFIG_DIR` (`<logs>/sessions`) and price them with `v4JudgeCost`. Fix the effortless arm's $0 judge record (`bench/e5-sessions.mts:149`) in the same phase. Neither fix is made in this report.
- **Unchanged:** routing code, `bench/external/`, the internal runners and historical rows.

### Protocol (Recommendation)

**Arms.** `automode` (v6c default) and `sonnet-high`, with an identical:
- Claude Code version, pinned through Harbor `version`;
- Harbor or Pier SHA;
- image digests and tool permissions;
- per-trial cap;
- timeout.

Pro V2 disallows WebFetch and WebSearch, and both arms follow its locked configuration.

**Conditional arms**, each added only for a stated question:

| Arm | Question it answers |
|---|---|
| `opus` | Where is the quality ceiling? |
| `haiku` | Where is the cheap floor? |
| `opusplan` | How does Claude Code's own routing compare? |
| `opus-effortless` | How does a competing router compare? |
| Ablations | One specific routing hypothesis each |

**Order.**
- Arms run interleaved within each task, in an order set by a seed.
- Tasks run in seeded order.
- The two arms run at the same time of day, so the provider's load is the same.

**Selection.**
- The seeded hash and the strata are fixed in the manifest before any result is seen:
  - Pro V2: repository and language.
  - Terminal-Bench: category and difficulty from `task.toml`.
  - DeepSWE: language.
- Stage 1 tasks form the **dev set** and are never evaluated.
- Any task whose result informs a code change moves to the dev set permanently.

**Billing.** Use an API key, so cost equals billed list price, for external runs. Subscription runs report the API-equivalent cost only, and the report labels which applies.

## K. Cost-aware evaluation architecture

Five layers limit spend. Only a provider-side limit could act on the bill itself, and whether one applies to these keys is Unverified. No layer is promised as a hard cap.

| Layer | Mechanism | Enforces | Residual risk |
|---|---|---|---|
| 1. Provider limit | Anthropic Console workspace spend limit, if it applies to the key (Unverified in this report) | The bill, at the provider | It may react with delay. The granularity is coarse. |
| 2. Client estimate | `--max-budget-usd` on each Claude Code run | Stops the run when the CLI's own estimate passes the cap | It is a client-side estimate. Calls in flight finish. Hook judges are outside it. |
| 3. Orchestrator admission | `admit()` (`bench/lib/admission.mts:31`): spent + reserved + next ≤ ceiling | No trial starts unless its reservation fits | Today it reserves the expected cost (`bench/run.mts:155`). It must reserve the per-trial cap. |
| 4. Per-trial timeout | Harbor and Pier timeouts; Pro V2's 50 minutes | Bounds wall time and indirectly cost | A run can still be expensive before the timeout fires. Termination races. |
| 5. Reconciliation | Ledger against provider usage after each stage (`bench/reconcile.mts`) | Detects drift; enforces nothing | Usage is reported late. |

**Spend can still overrun in five ways:**
- usage that reaches the ledger after the next trial was admitted;
- concurrent model calls inside one trial, such as subagents and hook judges;
- cache-write charges the estimate missed, such as 1-hour writes at 2×;
- calls that finish after a kill;
- infrastructure such as Modal, which the model price leaves out.

The design reduces these risks. It does not remove them, and no report or page may promise an absolute cap.

### Governor design (Recommendation)

The governor extends the existing names.

**Manifest fields:**
- `budget_usd`: the ceiling.
- `run_cap_usd`: the per-trial cap, also passed as `--max-budget-usd`.
- `max_wall_s`
- `max_trials`
- `parallel`
- `max_retries`: infrastructure retries only. Retries are never used to re-roll a failed solve.
- `stop_on_budget`
- `require_approval`: default `true` for any paid arm.

**Dry run.** `bench/lib/plan.mts` lists every task × arm × repeat with three costs:
- min and expected, from measured rows where they exist;
- conservative, from the cap.

Each figure carries its label. A plan hash covers the manifest, the task list and the code hash.

**Fail closed.** A paid run starts only when an approval record names the plan hash and a ceiling no higher than the approved one. A missing or mismatched record means nothing runs.

**Reservation.**
- An in-flight trial reserves `run_cap_usd` plus a judge allowance, released to the actual cost when the trial ends.
- `parallel` is cut so that parallel × reservation ≤ the remaining ceiling.
- A plan with an unbounded cap is refused.

**Accounting.**
- Spend is written to the ledger after every trial.
- Exhausted budgets and timeouts are recorded as outcomes and stay in the analysis, counted as failures with their cost.
- `infra_invalid` rows are retried once, then reported.

**Resume.**
- A resume is keyed by `run_id` and the manifest hash.
- A completed valid row is never rerun.
- A partly modified environment is never reused. Every attempt starts from a fresh container.

## M and O. Progressive protocol and cost forecast

**Per-trial planning figure.** $5 to $30, central $15 (Illustrative). It is anchored on published Terminal-Bench 4.0 Claude Code totals:
- about $14.30 per trial for Opus 5.5 at max;
- about $22.22 per trial for Sonnet 5.5 at max (third-party published, divided by 330).

Our arms run Sonnet at high and AutoMode at its own route, so actual costs may be lower. No per-trial cost is published for Pro V2. Its Claude Code cost is Unverified until Stage 1 measures it.

**Conservative reservation.** $40 per trial (Recommendation), applied equally to both arms. Stage 1 checks whether the cap cuts off trials. A cut-off trial counts as a failure, and the cut-off rate is reported.

| Stage | Tasks | Arms × repeats | Trials | Expected agent cost | Infrastructure and verification | Conservative exposure | Ceiling | Reused afterwards | Gate to next stage |
|---|---|---|---|---|---|---|---|---|---|
| 0 Integration | Oracle, no-op and fake agents, replayed traces | No paid agent | as needed | **$0, zero paid inference** | Local Docker compute. Pro V2 officially uses Modal: a Modal or local-Docker dry run, cost Unverified. | $0 inference | $0 | Contract tests, oracle trials | Every Stage 0 check passes (section Q) |
| 1 Smoke | 2 per P0 suite (dev set) | 2 × 1 | 8 | $120 (range $40–$240) | Modal for Pro V2 if used | $320 | **$350, needs approval** | Measured $/trial, cap-hit rate | Both arms run end to end; costs reconcile within 10% |
| 2 Pilot | 8–15 per P0 suite (planning range) | 2 × 1 | 32–60 (12 per suite gives 48) | $720 at 48 trials (range $160–$1,800 across 32–60 trials) | Same | $1,920 at 48 | Set from Stage 1 actuals; needs approval | All rows | Descriptive results reviewed; a power table recomputed with measured p, discordance and cost; spend within forecast |
| 3 Targeted | Sized by power and budget, for example 40 per P0 suite | 2 × 1 (2 repeats only if the power table justifies it) | about 160 | about $2,400 (range $800–$4,800) | Same | $6,400 | Preregistered; needs approval | All rows | The preregistered claim rule is evaluated; negative results are published |
| 4 Publication (optional) | Full CPU-only 63 or full 66, plus a sample of Pro V2 up to 642 | Prespecified | Up to 1,416 for the full suites × 2 arms | About $21k (range $7k–$42k) (Illustrative) | Same | Cap × trials | Explicit budget decision | — | Only for a leaderboard entry or a claim that needs it |

**Where the figures come from.** The expected costs and ranges are Illustrative, derived from third-party published costs. The exposure column is the recommended $40 cap × trials (Recommendation). After each stage, the actual costs replace the planning figure, and the next stage's forecast is recomputed from them. The ledger keeps estimate and actual side by side.

**Wall time.** The published Sonnet 5.5 average trial on Terminal-Bench is about 2 hours. At parallel 4, Stage 2 takes about a day.

**Folding stages in.** Stage 2 rows count toward Stage 3 only if the code, version pins and manifest are unchanged and the tasks are in the eval set.

## Benchmark gaming and low-quality patches

| Failure | Detection (objective first) |
|---|---|
| Narrow or hard-coded fix | Official hidden tests. Pro V2 re-grades the patch in a pristine image with no network. Terminal-Bench 4.1 runs agent code as an untrusted user. |
| Excess changes and new dependencies | Patch statistics from the saved diff: files, lines, new manifest entries. Reported per arm, not scored. |
| Removed functionality | Pro V2 runs the existing tests as well as the target tests. Regressions are reported. |
| Security regressions | Internal safety suite (`bench/safety/`), sandbox only. Terminal-Bench security tasks. |
| Retries hidden from cost | Cost comes from all attempts. Infrastructure retries are logged and capped. A model re-roll is not allowed. |
| Escalation that hides failed attempts | One trial's `total_cost_usd` includes every model the session called. Hook judges are added. `escalations` and `rescues` are recorded per row. |
| Contamination | Pro V2 and DeepSWE were built to resist it. Results are reported per suite. SWE-rebench is the deferred freshness check. |
| Overfitting to known tasks | Dev and eval sets are separate. Any task that informed a change moves to dev. The selection seed is fixed in advance. |

LLM-as-judge scoring stays secondary. `bench/grade.mts` has never been calibrated against human scores (`bench/calibration/` holds no human file), so it must not enter a primary metric.

## H and P. Public evidence and claim readiness

### Four questions each published benchmark answers

1. What does this benchmark test?
2. Why does that ability matter for routing?
3. How did AutoMode compare with fixed Sonnet High on verified quality and on total cost? Show both axes.
4. Can an independent engineer reproduce it? Link the manifest, the pins, the rows and the commands.

### Claim categories

| Category | Evidence required | Allowed wording |
|---|---|---|
| Current internal evidence | Existing rows, with limitations stated beside them: n, one run, tuning overlap, reused controls, incomplete judge cost | "On our internal 20-step mixed sessions, one run each, …" |
| Official subset completed | Stage 2 or later. Official verifier and dataset version. Subset size and selection seed shown. | "Evaluated on 12 of 63 tasks of Terminal-Bench 4.1 CPU-only, official verifier." Never "Terminal-Bench score" alone, and never anything implying leaderboard status. |
| Quality–cost improvement demonstrated | Stage 3 claim rule met: prespecified comparison, matched baseline, complete cost (judges included), CIs, quality gate passed | "X% lower cost per attempted task (95% CI …), pass-rate difference Y points (95% CI …), non-inferior at M." |
| Industry-leading | Stage 4 or later, against current competitors under equal conditions, scoped to named suites | Not claimable now. A pilot never supports it. |

**Never permitted:**
- FrontierHarness or other third-party savings presented as AutoMode savings.
- A weighted score that hides failures.
- "Official score" for a self-run.
- Dropping negative results.

**Per-benchmark results table** (website format):

| Benchmark, version | Tests | Tasks (subset or full, seed) | AutoMode pass (95% CI) | Sonnet High pass (95% CI) | Difference (95% CI) | Cost per attempt | Cost per pass | Cost ratio (95% CI) | Median wall time | Manifest | Source | Limits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

Show a Pareto plot of pass rate against cost per attempt beside the table.

**Updating the site.** Every new public number goes through the `publish-results` skill and `bench/results/headline.json`, so `tests/claims.test.mts` guards every page.

**Benchmark policies.** No published policy on trademarks or self-reporting was found for the P0 and P1 benchmarks (Unverified). Until one is found:
- cite each benchmark by name, version and URL;
- label results as self-run;
- submit to a leaderboard only through its own process (Terminal-Bench takes submissions in `leaderboard/submissions/`).

## I and Q. Roadmap and acceptance criteria

| Milestone | Work | Effort (engineering) | Paid inference | Done when |
|---|---|---|---|---|
| M0 Infrastructure | Harbor and Pier adapters, plugin-load proof, normaliser, judge-cost export, governor, pins | About 1–2 weeks | $0 | All Stage 0 checks below pass |
| M1 Smoke | Stage 1 | About 2 days | ≤ approved ceiling (suggested $350) | Both arms ran; costs reconciled; forecast recalibrated |
| M2 Pilot | Stage 2, plus a descriptive report | About 1 week | Approved | Report regenerates offline from the rows; spend within forecast |
| M3 Targeted | Preregistration, then Stage 3 | About 1–2 weeks | Approved | Claim rule evaluated and published, whatever the result |
| M4 DeepSWE and FrontierHarness tracks | Pier path, deduplicated task map | About 1 week | Approved | P1 results reported separately |

**Infrastructure complete (no paid inference):**
- Real P0 task definitions load from pinned versions.
- Harbor's oracle agent passes and the no-op agent fails on the selected tasks, through our adapter.
- The plugin-load acceptance test passes on the real CLI.
- The normaliser produces valid rows from real oracle trial JSON.
- The governor refuses an unapproved plan and refuses an over-ceiling reservation.
- A resume reuses completed rows by `run_id`.
- `npm run check`, `claude plugin validate . --strict` and `claude plugin test .` pass.
- Existing benchmark tests are unchanged and green.

**Pilot complete:**
- The approved trials ran end to end in matched environments.
- The ledger reconciles with provider usage within a stated tolerance.
- Reports regenerate offline.
- The budget controls stopped work at the ceiling in a dry test.

**Publication complete:**
- A frozen protocol was executed.
- The claim rule was evaluated, with limitations disclosed.
- Negative findings were published.
- Every claim links to its rows and manifest.

## Risks

| Risk | Mitigation |
|---|---|
| Cost overrun | Cap-based reservation, approval gate, staged ceilings, reconciliation, and no promise of a hard cap |
| Underpowered quality claims | Power table; descriptive labels; pooled preregistered analysis; narrower claims |
| Contamination | Pro V2 and DeepSWE; per-suite reporting; SWE-rebench deferred as a check |
| Harbor and Claude Code fragility | Pin Harbor, Pier and Claude Code versions; contract tests on real trial JSON; plugin-load test on each version bump |
| Cache accounting errors | Count 5-minute against 1-hour writes, hook judges, and API against subscription basis; reconcile against provider usage |
| CPU-only and HARD-51 misread as full suites | Report them as named subsets only |
| Overlapping tasks in FrontierHarness | Deduplicate; never count twice |
| Misleading public claims | Claim categories; `publish-results`; `tests/claims.test.mts` |
| Selection bias | Seeded, metadata-only selection; dev and eval split; a task that informs a change moves to dev |
| Licence gaps | FrontierHarness declares no licence: reference its task ids and metric only, copy no code. The Pro V2 HF dataset licence is Unverified: check it before redistribution. |

## J. Implementation prompt for Stages 0 and 1

The following prompt is self-contained and can be handed to a coding agent.

```text
You are working in the AutoMode repository (a Claude Code plugin). Read .claude/CLAUDE.md and
docs/proposals/benchmark-strategy.md first. Implement the benchmark infrastructure for Stages 0 and 1 of that
report, and prepare (do not run) the Stage 1 paid smoke run. Scope is limited to bench/ and its tests.

Rules
1. Plan before coding. Write the plan, list every file you will touch, and get it approved.
2. Follow the ship-change skill: one issue, one branch, one PR. Make small incremental commits on that branch.
3. Do not change hooks/, workflows/, bench/external/, the internal task sets, or any historical file in
   bench/results/. Existing benchmark behavior and tests must stay green.
4. Reuse before you build: bench/arms.mts, bench/lib/admission.mts, ledger.mts, plan.mts, identity.mts,
   manifest.mts, stats.mts, decide.mts, report.mts, run-one.mts (v4JudgeCost). Extend; do not rewrite.
5. Use the official runners and verifiers: Harbor for Terminal-Bench 4.1 and SWE-bench Pro V2, Pier for DeepSWE
   (DeepSWE work is optional here). Never edit task definitions, tests or verifier semantics. Keep each task's
   network isolation as upstream ships it. Pin every dataset version, git SHA and Claude Code version.
6. Plugin loading: try, in order, Harbor's settings `config` with a directory marketplace, then a prebuilt image
   with skip_install, then a thin subclass (of ClaudeCode, or of Pro V2's LockedClaudeCode) that only adds
   --plugin-dir. Stop at the first that passes this test on the real CLI: AutoMode decision records appear in the
   trial's saved session logs for the automode arm, and none for sonnet-high. Do not assume a mechanism works.
7. Normalise Harbor and Pier trial JSON into the existing row schema (accepted, cost_usd_api_equiv, judge,
   model_usage, wall_s, budget_exhausted, infra_invalid). Add AutoMode hook-judge cost from the saved session
   records. Record the effortless arm's judge cost too, instead of $0.
8. Budget governor: reserve run_cap_usd (plus a judge allowance) for each trial in flight, not the expected cost.
   Add a dry-run plan with min, expected and conservative cost, each labelled by source. Fail closed: a paid run
   needs an approval record naming the plan hash and a ceiling. Count capped and timed-out trials as failures
   with their cost. Resume by run_id and manifest hash; never reuse a modified environment. Document that
   --max-budget-usd is a client-side estimate and no layer is a hard billing cap.
9. Tests: unit tests for the normaliser, governor and selection; contract tests against real oracle and no-op
   trial JSON (captured from a real Harbor/Pier run that needs no paid model) checked into bench/fixtures;
   a functional test that runs the whole pipeline with a fake agent. New tests must run under npm test (top-level
   bench/*.test.mts or tests/*.test.mts).
10. Independent verification: have a separate reviewer agent check each adapter against the upstream source at
    the pinned SHA, and check for unnecessary complexity.
11. Never fabricate a measurement. No cost or pass number enters any doc, page or headline.json from this work.
    Stage 1 runs only after the user approves the printed plan and ceiling.
12. Before you finish: npm run check, claude plugin validate . --strict, claude plugin test ., and a review of
    the diff for quality and maintainability. Reports must record every version, SHA, seed and config used.
```
