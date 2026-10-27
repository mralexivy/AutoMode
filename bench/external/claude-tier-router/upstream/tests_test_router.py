"""Tests for TierRouter — uses mock clients, no real API calls."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from tier_router import TierRouter, FAST_MODEL, DEEP_MODEL, estimate_cost


def _mock_client(input_tokens: int = 100, output_tokens: int = 200):
    client = MagicMock()
    resp = MagicMock()
    resp.usage.input_tokens = input_tokens
    resp.usage.output_tokens = output_tokens
    client.messages.create.return_value = resp
    return client


def test_fast_routes_to_haiku():
    client = _mock_client()
    router = TierRouter(client)
    router.fast(messages=[{"role": "user", "content": "hi"}])
    call_kwargs = client.messages.create.call_args.kwargs
    assert call_kwargs["model"] == FAST_MODEL


def test_deep_routes_to_sonnet():
    client = _mock_client()
    router = TierRouter(client)
    router.deep(messages=[{"role": "user", "content": "hi"}])
    call_kwargs = client.messages.create.call_args.kwargs
    assert call_kwargs["model"] == DEEP_MODEL


def test_auto_structured_hint_routes_fast():
    client = _mock_client()
    router = TierRouter(client)
    router.auto(messages=[{"role": "user", "content": "hi"}], hint="extract JSON")
    assert client.messages.create.call_args.kwargs["model"] == FAST_MODEL


def test_auto_default_routes_deep():
    client = _mock_client()
    router = TierRouter(client)
    router.auto(messages=[{"role": "user", "content": "hi"}], hint="review architecture")
    assert client.messages.create.call_args.kwargs["model"] == DEEP_MODEL


def test_cost_accounting_per_tier():
    client = _mock_client(input_tokens=1000, output_tokens=500)
    router = TierRouter(client)
    router.fast(messages=[{"role": "user", "content": "x"}])
    router.deep(messages=[{"role": "user", "content": "y"}])

    breakdown = router.cost_breakdown()
    assert breakdown["fast_calls"] == 1
    assert breakdown["deep_calls"] == 1
    assert breakdown["total_tokens"] == 3000
    # sonnet should cost roughly 3.75x haiku for same token mix
    assert breakdown["deep_cost_usd"] > breakdown["fast_cost_usd"] * 3


def test_estimate_cost_unknown_model_uses_sonnet_fallback():
    c1 = estimate_cost("claude-sonnet-4-6", 1_000_000, 0)
    c2 = estimate_cost("unknown-model-xyz", 1_000_000, 0)
    assert c1 == c2  # fallback is sonnet pricing


def test_log_calls_disabled_skips_records():
    client = _mock_client()
    router = TierRouter(client, log_calls=False)
    router.fast(messages=[{"role": "user", "content": "x"}])
    assert router.records == []
    assert router.total_cost_usd == 0.0


def test_custom_models_override_defaults():
    client = _mock_client()
    router = TierRouter(client, fast_model="custom-fast", deep_model="custom-deep")
    router.fast(messages=[{"role": "user", "content": "x"}])
    assert client.messages.create.call_args.kwargs["model"] == "custom-fast"
