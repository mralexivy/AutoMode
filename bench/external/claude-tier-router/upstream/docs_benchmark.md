# Benchmark — Haiku-only vs Sonnet-only vs Tiered Routing

This benchmark measures the cost and quality gap between three strategies on a fixed workload:

| Strategy | Advocate tier | Judge tier |
|---|---|---|
| `haiku_only` | Haiku 4.5 | Haiku 4.5 |
| `sonnet_only` | Sonnet 4.6 | Sonnet 4.6 |
| `tiered` | Haiku 4.5 (structured tasks) | Sonnet 4.6 (reasoning tasks) |

## Workload

20 tasks split evenly:

- **10 structured tasks** — JSON extraction, classification, one-line summary, regex, SQL generation, translation, docstring. These have a single right answer and Haiku handles them reliably.
- **10 reasoning tasks** — strategy critique, architecture tradeoff, PR merge judgment, debugging by reasoning, migration planning, ML problem framing. These need chains of inference and Haiku tends to produce superficially-correct-but-actually-wrong answers.

Full task definitions in [`scripts/benchmark_tasks.py`](../scripts/benchmark_tasks.py).

## Methodology

Each task runs through each strategy once (use `--n 3` for stability). Quality is evaluated two ways:

1. **Automated signal hit** — each task has a simple `expected_signal` keyword. Hit rate is the fraction of responses containing the signal. Rough — a 100% signal hit does not guarantee high-quality answers, but a low signal hit rate is a reliable indicator of bad output.
2. **Manual review** — the `response_preview` field (first 200 chars) in `benchmark_results.jsonl` lets you eyeball quality on reasoning tasks. This is where the Haiku vs Sonnet gap becomes obvious.

Pricing uses the public Anthropic per-token rates baked into `tier_router.logger.estimate_cost`:

| Model | Input $/1M | Output $/1M |
|---|---|---|
| Haiku 4.5 | $0.80 | $4.00 |
| Sonnet 4.6 | $3.00 | $15.00 |

## How to run

```bash
export ANTHROPIC_API_KEY=sk-...
pip install -e '.[dev]'
python scripts/run_benchmark.py            # single pass, ~$0.10 total
python scripts/run_benchmark.py --n 3      # three reps, better stability
python scripts/run_benchmark.py --dry-run  # skip network, show task plan
```

Output:
- `docs/benchmark_results.jsonl` — one record per call
- `docs/benchmark_summary.json` — aggregated per strategy

## Expected result shape

Back-of-envelope using representative token counts from the orallexa workload (~300 input, ~200 output avg for structured; ~400 input, ~500 output for reasoning):

| Metric | `haiku_only` | `sonnet_only` | `tiered` |
|---|---|---|---|
| Total cost (20 tasks) | ~$0.012 | ~$0.095 | ~$0.055 |
| Relative cost | 1.0x | **~8x** | ~4.5x |
| Structured signal hit | ~100% | ~100% | ~100% |
| Reasoning signal hit | ~60% | ~95% | ~95% |

**Read:** Haiku-only is cheapest but loses on reasoning. Sonnet-only matches quality but costs ~8x. Tiered routing keeps Sonnet-quality on reasoning tasks (95% hit rate) at ~40% lower cost than Sonnet-only.

These numbers are a template — run the benchmark yourself for your actual workload.

## Why does tiered win

Two structural facts:

1. **Haiku's failure mode on reasoning is silent.** It outputs confident-sounding text that gets the reasoning wrong. You only catch it by reading the response, which defeats the point of automation. The `signal_hit` metric understates this — the signal keyword often appears in a wrong answer.

2. **Sonnet on structured tasks is expensive overkill.** A JSON extraction costs Sonnet ~$0.003; Haiku does the same work for ~$0.0003. If 70% of your calls are structured, you burn 10x more money for identical output.

The whole point of the tier router is to make it one line of code to stop burning that money.

## Caveats

- Reasoning quality is ultimately judgment-based. The signal hit rate is a sanity check, not a quality metric.
- Latency varies by API load time of day. Haiku is typically ~2-3x faster than Sonnet.
- These tasks were chosen to be clear-cut. Real workloads have an ambiguous middle where Haiku is acceptable but Sonnet is noticeably better. For those, measure on your own traffic.
