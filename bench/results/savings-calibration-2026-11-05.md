# Live savings calibration, 2026-11-05

The live savings estimate (`hooks/lib/savings.ts`) replayed against the v6 release benchmark with `bench/savings-replay.mts`. It read the AutoMode arm's own Claude Code transcripts, priced each main-session request on Opus with Opus's own warm cache, and compared the result with the measured plain-Opus arm on the same five sessions. No model was called. Numbers only: no prompt or reply text.

```
node bench/savings-replay.mts bench/results/v6-w2-release.jsonl --arm v6c-opus \
  --baseline-rows bench/results/v6-w1-mixed.jsonl --baseline-arm opus
```

| Session | Main requests | AutoMode, actual | Opus, estimated | Opus, measured | Saving, estimated | Saving, measured |
|---|---|---|---|---|---|---|
| boltons | 28 | $0.53 | $1.16 | $0.99 | $0.63 | $0.46 |
| jinja | 27 | $0.39 | $0.88 | $0.70 | $0.49 | $0.31 |
| jsyaml | 23 | $0.30 | $0.72 | $0.82 | $0.42 | $0.51 |
| marked | 35 | $0.58 | $1.26 | $1.11 | $0.69 | $0.53 |
| nodesemver | 18 | $0.21 | $0.51 | $0.54 | $0.31 | $0.33 |
| **Total** | **131** | **$2.00** | **$4.54** | **$4.14** | **$2.54 (56%)** | **$2.14 (52%)** |

## What it shows

- **The share is close.** 56% estimated against 52% measured.
- **The estimate runs high overall, by $0.40 on $4.14.** It reprices AutoMode's own tokens. Plain Opus wrote its own replies, with its own token counts, which the estimate cannot know.
- **Per session, it misses by up to $0.18 either way.** It was high on boltons, jinja and marked, and low on jsyaml and nodesemver.
- **AutoMode's judges cost $0.01 in these rows.**

## Limits

- Five sessions, one repetition. This is a check, not a law.
- The transcripts stay on the machine that ran the benchmark. Anyone else can run the tool only on their own runs.
- Subagent requests count as equal on both sides, and effort savings on the same model are left out.
