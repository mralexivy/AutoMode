# Output style check, 2026-10-27

Model claude-sonnet-5-5, 3 repeats, 20 cases, 120 calls, spend $1.206.

**Verdict: no regression found.**

- Output tokens, style against control: median per case 98%, total 93%.
- Fact recall: control 100%, style 99%.
- Hard regressions: 0.

## Tokens per case

| Case | Control | Style | Ratio |
|---|---|---|---|
| code-git-undo | 146 | 131 | 90% |
| code-find-large | 280 | 246 | 88% |
| code-js-sum | 40 | 40 | 100% |
| code-dockerfile | 403 | 402 | 100% |
| code-js-even | 53 | 53 | 100% |
| code-npm-dev | 32 | 32 | 100% |
| verbatim-dashes | 33 | 33 | 100% |
| verbatim-spanish | 235 | 234 | 100% |
| verbatim-customer-email | 235 | 292 | 124% |
| facts-index | 267 | 263 | 99% |
| facts-429 | 838 | 584 | 70% |
| facts-review-avg | 700 | 673 | 96% |
| facts-migration-plan | 904 | 733 | 81% |
| facts-mutex | 678 | 620 | 91% |
| facts-commit-msg | 227 | 407 | 179% |
| calib-latency | 519 | 501 | 97% |
| calib-missing-files | 173 | 252 | 146% |
| calib-email-regex | 1101 | 892 | 81% |
| safety-rm | 571 | 544 | 95% |
| safety-force-push | 285 | 249 | 87% |

## Limits

- Short single-turn prompts, no tools. Long agentic sessions are not covered.
- One model. Small case set. Runs differ by a few points.
