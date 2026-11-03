# AutoMode against plain Claude Code: 30 tasks, 2026-11-03

The proof run again after the routing fix (opusStart: evidence): AutoMode (auto) against plain Claude Code on Opus medium and Sonnet high, on the same 30 tasks. The two fixed arms run no plugin code, so their rows are reused from automode-proof.jsonl with identical run ids. Only auto is paid for again. Decisions use the same policies, unchanged: policies/automode-vs-opus-v1.json (primary) and automode-vs-sonnet-v1.json.

Rows: 92 paid attempts, 90 valid runs over 30 tasks. Costs are list-price equivalents (`cost_usd_api_equiv`). They count every paid attempt, cut-off ones included. Runs used a Claude subscription, so no money was billed per run.

## By arm

| Arm | What it is | Accepted | Paid attempts | Spend | $ per accepted | Median minutes |
|---|---|---:|---:|---:|---:|---:|
| `auto` | AutoMode Auto: model and effort routing | 29 of 30 | 32 | $9.50 | $0.33 | 1.3 |
| `opus-medium` | Opus 5.5, fixed medium | 30 of 30 | 30 | $14.54 | $0.48 | 1.3 |
| `sonnet-high` | Sonnet 5.5, fixed high | 30 of 30 | 30 | $7.20 | $0.24 | 1.1 |

## Decisions

Each policy was committed before the first row. Thresholds never move after a row exists.

### automode-vs-opus-v1: **SHIP**

> Does AutoMode (auto) pass as many tasks as plain Claude Code on Opus medium, at a lower cost per accepted task? The claim holds at a cost ratio of 0.80 or less with a 90% interval upper bound under 0.95, and at most 1 task lost net.

- Pairs: 30. `auto` accepted 29, `opus-medium` accepted 30. Net tasks lost by `auto`: 1.
- Cost per accepted: $0.33 against $0.48. Paired ratio 0.676, 90% bootstrap interval 0.517 to 0.826.
- Only `opus-medium` passed: longctx-sqlglot-intersect-precedence-across-dialects.

### automode-vs-sonnet-v1: **INCONCLUSIVE**

> Does AutoMode (auto) pass at least as many tasks as plain Claude Code on Sonnet high? AutoMode may spend more where it buys Opus: the claim holds at no task lost net and a cost ratio of 1.5 or less, interval upper bound under 2.0.

- Pairs: 30. `auto` accepted 29, `sonnet-high` accepted 30. Net tasks lost by `auto`: 1.
- Cost per accepted: $0.33 against $0.24. Paired ratio 1.366, 90% bootstrap interval 1.08 to 1.634.
- Only `sonnet-high` passed: longctx-sqlglot-intersect-precedence-across-dialects.
- Blocker: auto lost 1 tasks net (ship allows 0).
- Next: repeat the discordant and high-variance tasks: longctx-sqlglot-intersect-precedence-across-dialects.

## By task

| Task | `auto` | `opus-medium` | `sonnet-high` |
|---|---|---|---|
| feature-boltons-mapping-type-fixes | pass $0.22 | pass $0.34 | pass $0.18 |
| feature-fastxmlparser-stopnode-nested-same-tag | pass $0.12 | pass $0.23 | pass $0.13 |
| feature-findmyway-regex-param-empty-segment | pass $0.16 | pass $0.23 | pass $0.13 |
| feature-immer-array-plugin-spread-drafts | pass $0.22 | pass $0.67 | pass $0.26 |
| feature-jinja-undefined-copy-pickle-state | pass $0.20 | pass $0.38 | pass $0.19 |
| feature-markdown-unclosed-markup-in-code-spans | pass $0.32 | pass $0.51 | pass $0.26 |
| feature-marshmallow-schema-validator-data-key | pass $0.14 | pass $0.31 | pass $0.12 |
| feature-nodesemver-diff-prerelease-direction | pass $0.01 | pass $0.17 | pass $0.12 |
| feature-picomatch-repeated-extglob-branches | pass $0.12 | pass $0.21 | pass $0.14 |
| feature-postcss-inserted-sibling-visit-order | pass $0.16 | pass $0.31 | pass $0.17 |
| feature-qs-object-input-immutable | pass $0.13 | pass $0.57 | pass $0.16 |
| feature-sqlparse-begin-end-block-semicolons | pass $0.11 | pass $0.34 | pass $0.12 |
| feature-tomlkit-replace-dotted-with-table | pass $0.43 | pass $0.34 | pass $0.15 |
| feature-xmltodict-selective-cdata | pass $0.01 | pass $0.22 | pass $0.12 |
| longctx-dnspython-edns-padding | pass $0.53 | pass $0.59 | pass $0.45 |
| longctx-mistune-toc-heading-id-collisions | pass $0.04 | pass $0.30 | pass $0.14 |
| longctx-sqlglot-intersect-precedence-across-dialects | fail $2.40 | pass $2.77 | pass $1.52 |
| longctx-tornado-body-parse-errors-v2 | pass $0.27 | pass $0.63 | pass $0.31 |
| migration-cachetools-cachedmethod-instance-attributes | pass $0.34 | pass $0.72 | pass $0.37 |
| migration-marked-list-tokens-from-lexer | pass $1.19 | pass $0.72 | pass $0.39 |
| refactor-pymarkdown-block-level-v2 | pass $0.03 | pass $0.38 | pass $0.16 |
| security-findmyway-absolute-form-targets | pass $0.35 | pass $0.38 | pass $0.17 |
| security-markdownit-reference-continuation-quadratic | pass $0.23 | pass $0.60 | pass $0.19 |
| security-pyjwt-key-family-validation | pass $0.69 | pass $0.89 | pass $0.32 |
| security-tornado-header-control-chars-v2 | pass $0.30 | pass $0.34 | pass $0.16 |
| security-toughcookie-cookie-name-token-validation | pass $0.13 | pass $0.27 | pass $0.10 |
| security-toughcookie-secure-cookie-origin | pass $0.31 | pass $0.34 | pass $0.16 |
| security-yaml-recursive-merge-alias-limit | pass $0.28 | pass $0.47 | pass $0.31 |
| trivial-bottle-if-none-match-v2 | pass $0.01 | pass $0.14 | pass $0.09 |
| trivial-cheerio-data-mixed-selection | pass $0.07 | pass $0.17 | pass $0.08 |

## How we got here: the first run, the cause and the fix

The first run (`automode-proof`, the rows in `automode-proof.jsonl`) ran AutoMode as shipped against the same arms. AutoMode lost: 28 of 30 at $0.53 per accepted, against Opus medium at $0.48 and Sonnet high at $0.24. Against Sonnet high the policy said DO_NOT_SHIP.

### First run, by arm

| Arm | What it is | Accepted | Paid attempts | Spend | $ per accepted | Median minutes |
|---|---|---:|---:|---:|---:|---:|
| `auto` | AutoMode Auto: model and effort routing | 28 of 30 | 30 | $14.95 | $0.53 | 1.9 |
| `opus-medium` | Opus 5.5, fixed medium | 30 of 30 | 30 | $14.54 | $0.48 | 1.3 |
| `sonnet-high` | Sonnet 5.5, fixed high | 30 of 30 | 30 | $7.20 | $0.24 | 1.1 |
| `baseline` | AutoMode Auto, rescue settings at their old behavior | 30 of 30 | 30 | $15.40 | $0.51 | 1.8 |

### The cause

The judge sent too much work to Opus. Each row below groups the 30 tasks by the model the `auto` arm ran, and puts beside it what `sonnet-high` paid on the same tasks.

| `auto` ran | Tasks | `auto` passed | `auto` spend | `sonnet-high` spend on the same tasks | `sonnet-high` passed |
|---|---:|---:|---:|---:|---:|
| Opus | 15 | 13 | $12.49 | $4.51 | 15 |
| Sonnet | 11 | 11 | $2.37 | $2.18 | 11 |
| Haiku | 4 | 4 | $0.08 | $0.51 | 4 |

- **Opus routing is the whole loss.** Half the tasks went to Opus at high effort, for 2.8 times the cost, and Sonnet high passed all of them. Both `auto` failures were on this route or the one the judge chose by chance: on sqlglot the same code picked Sonnet for `auto` and Opus for `baseline`.
- **Haiku routing works.** 4 tasks ran 6 times cheaper than on Sonnet high, and none failed.
- **The judges cost $0.02 in all.** Routing overhead is not the problem. The routes are.
- **The rescue ladder fired 7 times under `auto` and 3 under `baseline`.** The history replay before the run predicted it: the new defaults escalate more often.

**What follows for the product.** AutoMode should start work on Sonnet, keep its Haiku routing, and move to Opus only on evidence. A counterfactual that prices `auto`'s Opus tasks at the Sonnet high rows gives about $6.96 for 30 tasks, against $7.19 for Sonnet high and $14.54 for Opus medium. That is a hypothesis, not a result. It needs a new `auto` run. The 90 rows of the other three arms stay valid for it, so the check costs about 30 runs, not 120.

### The fix and this rerun

AutoMode now starts T3 work on Sonnet high and moves to Opus only on failure evidence (`opusStart: evidence`). A free replay of the 30 recorded route decisions showed 12 Opus starts becoming Sonnet high, with the other 18 routes unchanged. This rerun paid only for the `auto` arm. The two fixed arms run no plugin code, so their 60 rows were reused with identical run ids. The decision policies are the ones committed before the first run, unchanged. The rerun hit the plan's usage limit once. It paused, resumed itself at the stated reset, and lost $0.40 to 2 cut-off attempts, which reran.

## What this does and does not show

- **Scale.** 30 tasks with 1 repetition is a release signal of limited precision. It is not a general claim, and the intervals above say how wide the uncertainty is.
- **Quality.** The hidden tests decide acceptance: the full suite of the task, never a subset the agent picked. No judge score is used here.
- **Sample.** The 4 tasks that failed in earlier rounds are in the set on purpose, so the escalation ladder is exercised. The other 26 come in SHA-256 order, at most 3 per repository, with no held-out task.
- **Order.** The arms ran interleaved by task on the same day and machine. A change in model availability during the run would affect all arms alike.

## Reproduce

```bash
node bench/proof-report.mts --experiment automode-proof-v2 --policies bench/experiments/policies/automode-vs-opus-v1.json,bench/experiments/policies/automode-vs-sonnet-v1.json   # this report, no model call
node bench/decide.mts bench/results/automode-proof-v2.jsonl --policy bench/experiments/policies/automode-vs-opus-v1.json   # one decision
node bench/regrade.mts bench/results/automode-proof-v2.jsonl --diffs bench/results/diffs   # regrade the saved diffs, no model call
node bench/preflight.mts --experiment automode-proof-v2 && node bench/run.mts --experiment automode-proof-v2   # a fresh paid rerun into a new results file (--out)
```
