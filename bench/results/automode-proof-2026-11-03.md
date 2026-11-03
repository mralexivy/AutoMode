# AutoMode against plain Claude Code: 30 tasks, 2026-11-03

Published proof: AutoMode as shipped (auto) against plain Claude Code on Opus medium and Sonnet high, and against AutoMode's old defaults (baseline), on the 30 rescue-confirm tasks, 1 repetition, paired. Decisions, fixed before any row: policies/automode-vs-opus-v1.json (primary), automode-vs-sonnet-v1.json, rescue-ship-v1.json (auto against baseline). A release signal on 30 tasks, of limited precision.

Rows: 120 paid attempts, 120 valid runs over 30 tasks. Costs are list-price equivalents (`cost_usd_api_equiv`). They count every paid attempt, cut-off ones included. Runs used a Claude subscription, so no money was billed per run.

## By arm

| Arm | What it is | Accepted | Paid attempts | Spend | $ per accepted | Median minutes |
|---|---|---:|---:|---:|---:|---:|
| `auto` | AutoMode Auto: model and effort routing | 28 of 30 | 30 | $14.95 | $0.53 | 1.9 |
| `opus-medium` | Opus 5.5, fixed medium | 30 of 30 | 30 | $14.54 | $0.48 | 1.3 |
| `sonnet-high` | Sonnet 5.5, fixed high | 30 of 30 | 30 | $7.20 | $0.24 | 1.1 |
| `baseline` | AutoMode Auto, rescue settings at their old behavior | 30 of 30 | 30 | $15.40 | $0.51 | 1.8 |

## Decisions

Each policy was committed before the first row. Thresholds never move after a row exists.

### automode-vs-opus-v1: **INCONCLUSIVE**

> Does AutoMode (auto) pass as many tasks as plain Claude Code on Opus medium, at a lower cost per accepted task? The claim holds at a cost ratio of 0.80 or less with a 90% interval upper bound under 0.95, and at most 1 task lost net.

- Pairs: 30. `auto` accepted 28, `opus-medium` accepted 30. Net tasks lost by `auto`: 2.
- Cost per accepted: $0.53 against $0.48. Paired ratio 1.101, 90% bootstrap interval 0.852 to 1.402.
- Only `opus-medium` passed: longctx-sqlglot-intersect-precedence-across-dialects, migration-cachetools-cachedmethod-instance-attributes.
- Blocker: auto lost 2 tasks net (ship allows 1).
- Blocker: cost ratio 1.10 is over 0.8.
- Blocker: cost ratio CI upper 1.40 is over 0.95: too uncertain to ship.
- Next: repeat the discordant and high-variance tasks: longctx-sqlglot-intersect-precedence-across-dialects, migration-cachetools-cachedmethod-instance-attributes.

### automode-vs-sonnet-v1: **DO_NOT_SHIP**

> Does AutoMode (auto) pass at least as many tasks as plain Claude Code on Sonnet high? AutoMode may spend more where it buys Opus: the claim holds at no task lost net and a cost ratio of 1.5 or less, interval upper bound under 2.0.

- Pairs: 30. `auto` accepted 28, `sonnet-high` accepted 30. Net tasks lost by `auto`: 2.
- Cost per accepted: $0.53 against $0.24. Paired ratio 2.226, 90% bootstrap interval 1.706 to 2.909.
- Only `sonnet-high` passed: longctx-sqlglot-intersect-precedence-across-dialects, migration-cachetools-cachedmethod-instance-attributes.
- Blocker: auto lost 2 tasks net (no-ship at 2).
- Blocker: cost per accepted is higher with confidence: ratio CI [1.71, 2.91].

### rescue-ship-v1: **INCONCLUSIVE**

> Do the rescue defaults (arm auto) keep the pass rate of the old defaults (arm baseline) at no more than 10% higher cost per accepted task?

- Pairs: 30. `auto` accepted 28, `baseline` accepted 30. Net tasks lost by `auto`: 2.
- Cost per accepted: $0.53 against $0.51. Paired ratio 1.04, 90% bootstrap interval 0.801 to 1.422.
- Only `baseline` passed: longctx-sqlglot-intersect-precedence-across-dialects, migration-cachetools-cachedmethod-instance-attributes.
- Blocker: auto lost 2 tasks net (ship allows 1).
- Blocker: cost ratio CI upper 1.42 is over 1.3: too uncertain to ship.
- Next: repeat the discordant and high-variance tasks: longctx-sqlglot-intersect-precedence-across-dialects, migration-cachetools-cachedmethod-instance-attributes.

## By task

| Task | `auto` | `opus-medium` | `sonnet-high` | `baseline` |
|---|---|---|---|---|
| feature-boltons-mapping-type-fixes | pass $0.45 | pass $0.34 | pass $0.18 | pass $0.46 |
| feature-fastxmlparser-stopnode-nested-same-tag | pass $0.13 | pass $0.23 | pass $0.13 | pass $0.43 |
| feature-findmyway-regex-param-empty-segment | pass $0.38 | pass $0.23 | pass $0.13 | pass $0.30 |
| feature-immer-array-plugin-spread-drafts | pass $0.27 | pass $0.67 | pass $0.26 | pass $0.66 |
| feature-jinja-undefined-copy-pickle-state | pass $0.20 | pass $0.38 | pass $0.19 | pass $0.17 |
| feature-markdown-unclosed-markup-in-code-spans | pass $0.29 | pass $0.51 | pass $0.26 | pass $0.16 |
| feature-marshmallow-schema-validator-data-key | pass $0.13 | pass $0.31 | pass $0.12 | pass $0.13 |
| feature-nodesemver-diff-prerelease-direction | pass $0.21 | pass $0.17 | pass $0.12 | pass $0.22 |
| feature-picomatch-repeated-extglob-branches | pass $0.13 | pass $0.21 | pass $0.14 | pass $0.42 |
| feature-postcss-inserted-sibling-visit-order | pass $0.60 | pass $0.31 | pass $0.17 | pass $0.19 |
| feature-qs-object-input-immutable | pass $1.77 | pass $0.57 | pass $0.16 | pass $0.14 |
| feature-sqlparse-begin-end-block-semicolons | pass $0.13 | pass $0.34 | pass $0.12 | pass $0.31 |
| feature-tomlkit-replace-dotted-with-table | pass $0.77 | pass $0.34 | pass $0.15 | pass $0.17 |
| feature-xmltodict-selective-cdata | pass $0.01 | pass $0.22 | pass $0.12 | pass $0.09 |
| longctx-dnspython-edns-padding | pass $1.51 | pass $0.59 | pass $0.45 | pass $1.21 |
| longctx-mistune-toc-heading-id-collisions | pass $0.02 | pass $0.30 | pass $0.14 | pass $0.02 |
| longctx-sqlglot-intersect-precedence-across-dialects | fail $1.72 | pass $2.77 | pass $1.52 | pass $4.04 |
| longctx-tornado-body-parse-errors-v2 | pass $0.32 | pass $0.63 | pass $0.31 | pass $0.32 |
| migration-cachetools-cachedmethod-instance-attributes | fail $0.85 | pass $0.72 | pass $0.37 | pass $0.99 |
| migration-marked-list-tokens-from-lexer | pass $0.44 | pass $0.72 | pass $0.39 | pass $0.48 |
| refactor-pymarkdown-block-level-v2 | pass $0.05 | pass $0.38 | pass $0.16 | pass $0.02 |
| security-findmyway-absolute-form-targets | pass $0.91 | pass $0.38 | pass $0.17 | pass $0.91 |
| security-markdownit-reference-continuation-quadratic | pass $1.31 | pass $0.60 | pass $0.19 | pass $0.75 |
| security-pyjwt-key-family-validation | pass $0.69 | pass $0.89 | pass $0.32 | pass $0.69 |
| security-tornado-header-control-chars-v2 | pass $0.24 | pass $0.34 | pass $0.16 | pass $0.35 |
| security-toughcookie-cookie-name-token-validation | pass $0.18 | pass $0.27 | pass $0.10 | pass $0.24 |
| security-toughcookie-secure-cookie-origin | pass $0.52 | pass $0.34 | pass $0.16 | pass $0.68 |
| security-yaml-recursive-merge-alias-limit | pass $0.61 | pass $0.47 | pass $0.31 | pass $0.78 |
| trivial-bottle-if-none-match-v2 | pass $0.01 | pass $0.14 | pass $0.09 | pass $0.01 |
| trivial-cheerio-data-mixed-selection | pass $0.09 | pass $0.17 | pass $0.08 | pass $0.08 |

## Why AutoMode lost

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

## What this does and does not show

- **Scale.** 30 tasks with 1 repetition is a release signal of limited precision. It is not a general claim, and the intervals above say how wide the uncertainty is.
- **Quality.** The hidden tests decide acceptance: the full suite of the task, never a subset the agent picked. No judge score is used here.
- **Sample.** The 4 tasks that failed in earlier rounds are in the set on purpose, so the escalation ladder is exercised. The other 26 come in SHA-256 order, at most 3 per repository, with no held-out task.
- **Order.** The arms ran interleaved by task on the same day and machine. A change in model availability during the run would affect all arms alike.

## Reproduce

```bash
node bench/proof-report.mts --experiment automode-proof --policies bench/experiments/policies/automode-vs-opus-v1.json,bench/experiments/policies/automode-vs-sonnet-v1.json,bench/experiments/policies/rescue-ship-v1.json   # this report, no model call
node bench/decide.mts bench/results/automode-proof.jsonl --policy bench/experiments/policies/automode-vs-opus-v1.json   # one decision
node bench/regrade.mts bench/results/automode-proof.jsonl --diffs bench/results/diffs   # regrade the saved diffs, no model call
node bench/preflight.mts --experiment automode-proof && node bench/run.mts --experiment automode-proof   # a fresh paid rerun into a new results file (--out)
```
