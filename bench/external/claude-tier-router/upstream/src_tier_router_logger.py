"""Per-call cost + token tracking for TierRouter."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

PRICING_USD_PER_TOKEN = {
    "claude-haiku-4-5-20251001": {"input": 0.80 / 1_000_000, "output": 4.00 / 1_000_000},
    "claude-sonnet-4-6":         {"input": 3.00 / 1_000_000, "output": 15.00 / 1_000_000},
}
_FALLBACK = {"input": 3.00 / 1_000_000, "output": 15.00 / 1_000_000}


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    rates = PRICING_USD_PER_TOKEN.get(model, _FALLBACK)
    return input_tokens * rates["input"] + output_tokens * rates["output"]


def get_tier(model: str) -> str:
    return "FAST" if "haiku" in model.lower() else "DEEP"


@dataclass
class CallRecord:
    timestamp: str
    model: str
    tier: str
    input_tokens: int
    output_tokens: int
    cost_usd: float


def record_call(*, model: str, response: Any) -> CallRecord:
    usage = getattr(response, "usage", None)
    in_t = getattr(usage, "input_tokens", 0) if usage else 0
    out_t = getattr(usage, "output_tokens", 0) if usage else 0
    return CallRecord(
        timestamp=datetime.now(timezone.utc).isoformat(),
        model=model,
        tier=get_tier(model),
        input_tokens=in_t,
        output_tokens=out_t,
        cost_usd=round(estimate_cost(model, in_t, out_t), 6),
    )
