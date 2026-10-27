"""
TierRouter — drop-in wrapper over anthropic.Anthropic.messages.create that
routes calls to Haiku (fast, cheap, structured) or Sonnet (deep reasoning).

Default routing rules:
  - fast(): claude-haiku-4-5  (~$0.80 in / $4 out per 1M tokens)
  - deep(): claude-sonnet-4-6 (~$3 in / $15 out per 1M tokens)

Deep calls cost ~3.75x more. In a typical Claude Code workflow, 80%+ of calls
are structured (JSON extraction, summaries, parameter generation) and don't
need Sonnet-tier reasoning. Routing those to Haiku cuts the bill roughly 10x
without measurable quality loss.
"""
from __future__ import annotations

from typing import Any

from tier_router.logger import CallRecord, record_call

FAST_MODEL = "claude-haiku-4-5-20251001"
DEEP_MODEL = "claude-sonnet-4-6"


class TierRouter:
    """Thin wrapper over an anthropic.Anthropic client with two tiers.

    Usage:
        from anthropic import Anthropic
        from tier_router import TierRouter

        router = TierRouter(Anthropic())

        # Structured / fast tasks -> Haiku
        resp = router.fast(messages=[{"role": "user", "content": "Extract JSON from..."}])

        # Reasoning / decisions -> Sonnet
        resp = router.deep(messages=[{"role": "user", "content": "Review this strategy..."}])

        # Per-call cost tracking
        print(router.total_cost_usd)  # running total since construction
    """

    def __init__(
        self,
        client: Any,
        *,
        fast_model: str = FAST_MODEL,
        deep_model: str = DEEP_MODEL,
        log_calls: bool = True,
    ):
        self.client = client
        self.fast_model = fast_model
        self.deep_model = deep_model
        self.log_calls = log_calls
        self.records: list[CallRecord] = []

    def fast(self, *, messages: list, max_tokens: int = 512, **kwargs) -> Any:
        """Route to Haiku. Use for: JSON extraction, summaries, structured output."""
        return self._call(self.fast_model, messages=messages, max_tokens=max_tokens, **kwargs)

    def deep(self, *, messages: list, max_tokens: int = 1024, **kwargs) -> Any:
        """Route to Sonnet. Use for: reasoning, decisions, strategy review."""
        return self._call(self.deep_model, messages=messages, max_tokens=max_tokens, **kwargs)

    def auto(self, *, messages: list, hint: str = "", **kwargs) -> Any:
        """Route based on hint. 'structured'|'extract'|'summary' -> fast, else deep."""
        h = hint.lower()
        if any(k in h for k in ("structured", "extract", "json", "summary", "parse")):
            return self.fast(messages=messages, **kwargs)
        return self.deep(messages=messages, **kwargs)

    def _call(self, model: str, *, messages: list, max_tokens: int, **kwargs) -> Any:
        response = self.client.messages.create(
            model=model, max_tokens=max_tokens, messages=messages, **kwargs
        )
        if self.log_calls:
            rec = record_call(model=model, response=response)
            self.records.append(rec)
        return response

    @property
    def total_cost_usd(self) -> float:
        return sum(r.cost_usd for r in self.records)

    @property
    def total_tokens(self) -> int:
        return sum(r.input_tokens + r.output_tokens for r in self.records)

    def cost_breakdown(self) -> dict:
        """Return per-tier call count + cost summary."""
        fast = [r for r in self.records if r.tier == "FAST"]
        deep = [r for r in self.records if r.tier == "DEEP"]
        return {
            "fast_calls": len(fast),
            "deep_calls": len(deep),
            "fast_cost_usd": round(sum(r.cost_usd for r in fast), 6),
            "deep_cost_usd": round(sum(r.cost_usd for r in deep), 6),
            "total_cost_usd": round(self.total_cost_usd, 6),
            "total_tokens": self.total_tokens,
        }
