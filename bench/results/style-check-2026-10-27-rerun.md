# Output style check, 2026-10-27

Model claude-sonnet-5-5, 3 repeats, 3 cases, 18 calls, spend $0.178.

**Verdict: no regression found.**

- Output tokens, style against control: median per case 88%, total 83%.
- Fact recall: control n/a, style n/a.
- Hard regressions: 0.

## Tokens per case

| Case | Control | Style | Ratio |
|---|---|---|---|
| code-dockerfile | 158 | 158 | 100% |
| calib-missing-files | 312 | 207 | 66% |
| safety-rm | 564 | 498 | 88% |

## Limits

- Short single-turn prompts, no tools. Long agentic sessions are not covered.
- One model. Small case set. Runs differ by a few points.
