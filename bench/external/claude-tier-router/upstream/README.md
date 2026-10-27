# claude-tier-router

[![tests](https://github.com/alex-jb/claude-tier-router/actions/workflows/tests.yml/badge.svg)](https://github.com/alex-jb/claude-tier-router/actions/workflows/tests.yml)
[![python](https://img.shields.io/badge/python-3.9%2B-blue)](https://www.python.org)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Cut your Claude API bill ~10x without losing quality.** A drop-in router over `anthropic.Anthropic` that sends structured/fast tasks to Haiku 4.5 and reasoning/decision tasks to Sonnet 4.6.

Also ships as a [Claude Code skill](#claude-code-skill) that teaches the agent when to use which tier.

## The problem

Most Claude apps hardcode `model="claude-sonnet-4-6"` everywhere. But 80%+ of real calls are structured — JSON extraction, summaries, classification, parameter generation — where Haiku is indistinguishable from Sonnet at **~4x lower cost**. Nobody bothers routing manually, so they overpay silently.

## The math

| Model | $/1M input | $/1M output | Per-call relative cost |
|---|---|---|---|
| Haiku 4.5 | $0.80 | $4.00 | **1x** |
| Sonnet 4.6 | $3.00 | $15.00 | **~3.75x** |

A typical mixed workload (80% structured, 20% reasoning) pays:

```
all-Sonnet:  100% * 3.75 = 3.75 units
tiered:       80% * 1.00 + 20% * 3.75 = 1.55 units
→ 59% cheaper, zero quality loss
```

In real use (a trading agent with 9 ML model outputs processed per run), the actual savings came out to **~10x** because the bulk of calls were pure JSON reshaping where Haiku is effectively free.

See [`docs/benchmark.md`](docs/benchmark.md) for a reproducible 20-task benchmark across Haiku-only, Sonnet-only, and tiered routing — with a runnable script at [`scripts/run_benchmark.py`](scripts/run_benchmark.py).

## Install

```bash
# Until v0.1 hits PyPI, install from git:
pip install git+https://github.com/alex-jb/claude-tier-router.git

# Or clone for development:
git clone https://github.com/alex-jb/claude-tier-router.git
cd claude-tier-router && pip install -e '.[dev]'
```

## Usage

```python
from anthropic import Anthropic
from tier_router import TierRouter

router = TierRouter(Anthropic())

# Structured / extraction -> Haiku (fast)
resp = router.fast(messages=[
    {"role": "user", "content": "Extract ticker + sentiment as JSON from: 'AAPL looks strong today'"}
])

# Reasoning / review -> Sonnet (deep)
resp = router.deep(messages=[
    {"role": "user", "content": "Critique this trading strategy and name 3 weaknesses: ..."}
])

# Or let the router pick based on a task hint
resp = router.auto(messages=[...], hint="extract JSON")  # -> fast
resp = router.auto(messages=[...], hint="critique strategy")  # -> deep

# Inspect per-call cost (no external logger needed)
print(router.cost_breakdown())
# {'fast_calls': 3, 'deep_calls': 1, 'fast_cost_usd': 0.002, ...}
```

Same `messages.create` signature — just swap `client.messages.create(...)` for `router.fast(...)` or `router.deep(...)`. Everything else (system prompts, temperature, stop sequences) passes through.

## When to use each tier

**FAST (Haiku) — default choice:**
- JSON extraction / structured output
- Summarize a paragraph to one sentence
- Parameter generation with explicit constraints
- Classification (sentiment, intent, category)
- Single-choice selection

**DEEP (Sonnet) — only when quality is user-visible:**
- Chain-of-reasoning over multiple facts
- Strategy critique / architectural review
- Final report a human will actually read
- Decision with real downstream cost if wrong

When in doubt, start with FAST. If the output looks vague, escalate to DEEP and note the pattern for next time.

## Claude Code skill

Drop `.claude/skills/tier-router/` into your Claude Code project and the agent learns when to pick each tier. See [`.claude/skills/tier-router/SKILL.md`](.claude/skills/tier-router/SKILL.md).

## Composes with claude-debate

[`claude-debate`](https://github.com/alex-jb/claude-debate) uses `claude-tier-router` internally — the advocate and critic run on the fast tier, the judge runs on the deep tier. If you install claude-debate, you get this routing for free. Both packages, one pattern.

## Why not just use `claude-haiku` everywhere?

Because quality collapses on real reasoning tasks — strategy critique, architectural decisions, multi-step plans. Haiku is sharp inside a narrow scope (extract X from Y) but vague on open-ended judgment. The point of tiering is to spend Sonnet tokens exactly where they move the needle.

## Custom models

```python
router = TierRouter(
    Anthropic(),
    fast_model="claude-haiku-4-5-20251001",
    deep_model="claude-opus-4-7",  # use Opus instead of Sonnet for deep
)
```

## Dev

```bash
pip install -e '.[dev]'
pytest
```

## License

MIT — see [LICENSE](LICENSE).

## Credits

Pattern extracted from [orallexa-ai-trading-agent](https://github.com/alex-jb/orallexa-ai-trading-agent), where dual-tier routing cut per-analysis cost from ~$0.03 to ~$0.003.
