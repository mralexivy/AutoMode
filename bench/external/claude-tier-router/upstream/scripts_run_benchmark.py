"""
Run the benchmark task set through Haiku-only, Sonnet-only, and tiered routing.
Reports per-task and aggregate token + cost data. Quality scoring is manual —
eyeball the `responses.jsonl` output to judge whether Haiku's answers on
reasoning tasks are actually usable (they usually aren't — that's the point).

Requires: ANTHROPIC_API_KEY env var
Usage:
    python scripts/run_benchmark.py
    python scripts/run_benchmark.py --n 3       # run each task N times
    python scripts/run_benchmark.py --dry-run   # skip network, show plan only
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Literal

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from anthropic import Anthropic
from tier_router import FAST_MODEL, DEEP_MODEL, estimate_cost

sys.path.insert(0, str(Path(__file__).resolve().parent))
from benchmark_tasks import ALL_TASKS, BenchmarkTask


Strategy = Literal["haiku_only", "sonnet_only", "tiered"]
RESULTS_PATH = Path(__file__).resolve().parent.parent / "docs" / "benchmark_results.jsonl"


def pick_model(strategy: Strategy, task: BenchmarkTask) -> str:
    if strategy == "haiku_only":
        return FAST_MODEL
    if strategy == "sonnet_only":
        return DEEP_MODEL
    # tiered: fast for structured, deep for reasoning
    return FAST_MODEL if task.kind == "structured" else DEEP_MODEL


def run_one(client: Anthropic, task: BenchmarkTask, strategy: Strategy) -> dict:
    model = pick_model(strategy, task)
    t0 = time.monotonic()
    resp = client.messages.create(
        model=model,
        max_tokens=600,
        temperature=0,
        messages=[{"role": "user", "content": task.prompt}],
    )
    latency_ms = int((time.monotonic() - t0) * 1000)

    text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
    in_t = resp.usage.input_tokens
    out_t = resp.usage.output_tokens
    cost = estimate_cost(model, in_t, out_t)
    signal_hit = task.expected_signal.lower() in text.lower() if task.expected_signal else True

    return {
        "task_id": task.id,
        "kind": task.kind,
        "strategy": strategy,
        "model": model,
        "input_tokens": in_t,
        "output_tokens": out_t,
        "cost_usd": round(cost, 6),
        "latency_ms": latency_ms,
        "signal_hit": signal_hit,
        "response_preview": text[:200],
    }


def summarize(records: list[dict]) -> dict:
    """Aggregate per-strategy: total cost, total tokens, signal-hit rate."""
    by_strategy: dict[str, list[dict]] = {}
    for r in records:
        by_strategy.setdefault(r["strategy"], []).append(r)

    summary = {}
    for strat, rs in by_strategy.items():
        total_cost = sum(r["cost_usd"] for r in rs)
        total_in = sum(r["input_tokens"] for r in rs)
        total_out = sum(r["output_tokens"] for r in rs)
        hits = sum(1 for r in rs if r["signal_hit"])
        structured_hits = sum(1 for r in rs if r["signal_hit"] and r["kind"] == "structured")
        reasoning_hits = sum(1 for r in rs if r["signal_hit"] and r["kind"] == "reasoning")
        summary[strat] = {
            "n_tasks": len(rs),
            "total_cost_usd": round(total_cost, 6),
            "total_input_tokens": total_in,
            "total_output_tokens": total_out,
            "signal_hits": hits,
            "signal_hit_rate": round(hits / len(rs), 3),
            "structured_hits": structured_hits,
            "reasoning_hits": reasoning_hits,
            "avg_latency_ms": int(sum(r["latency_ms"] for r in rs) / len(rs)),
        }
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=1, help="repetitions per task")
    parser.add_argument("--dry-run", action="store_true", help="skip network calls")
    args = parser.parse_args()

    print(f"Benchmark plan: {len(ALL_TASKS)} tasks * 3 strategies * {args.n} reps = {len(ALL_TASKS) * 3 * args.n} calls")
    if args.dry_run:
        for task in ALL_TASKS:
            print(f"  [{task.kind}] {task.id}: {task.prompt[:70]}...")
        return

    client = Anthropic()
    records = []
    for task in ALL_TASKS:
        for strategy in ("haiku_only", "sonnet_only", "tiered"):
            for rep in range(args.n):
                try:
                    rec = run_one(client, task, strategy)
                    rec["rep"] = rep
                    records.append(rec)
                    print(f"  {task.id:<25} {strategy:<12} ${rec['cost_usd']:.5f} "
                          f"{rec['input_tokens']:>4}in {rec['output_tokens']:>4}out "
                          f"{'✓' if rec['signal_hit'] else '✗'}")
                except Exception as e:
                    print(f"  {task.id:<25} {strategy:<12} ERROR: {e}")

    RESULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(RESULTS_PATH, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")

    summary = summarize(records)
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    for strat, s in summary.items():
        print(f"\n{strat}:")
        for k, v in s.items():
            print(f"  {k}: {v}")

    summary_path = RESULTS_PATH.with_name("benchmark_summary.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    print(f"\nWrote {RESULTS_PATH} and {summary_path}")


if __name__ == "__main__":
    main()
