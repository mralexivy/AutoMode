"""
Benchmark task set for tier-router.

Two task categories:
  - STRUCTURED: JSON extraction, classification, summarization (Haiku handles these)
  - REASONING: critique, tradeoff analysis, multi-step decisions (Sonnet territory)

Each task has a prompt and a simple grader hint. The benchmark script runs every
task on Haiku alone, Sonnet alone, and auto-routed, then reports cost + token
counts. Quality scoring is manual — these tasks are chosen so both tiers produce
a usable answer on structured and only Sonnet produces a usable answer on
reasoning, so you can eyeball the quality gap.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

TaskKind = Literal["structured", "reasoning"]


@dataclass
class BenchmarkTask:
    id: str
    kind: TaskKind
    prompt: str
    expected_signal: str  # what a "good" answer must contain (manual grading hint)


STRUCTURED_TASKS: list[BenchmarkTask] = [
    BenchmarkTask(
        id="extract_ticker",
        kind="structured",
        prompt='Extract as JSON {"ticker": "...", "sentiment": "bull|bear|neutral"} from: "NVDA is looking strong today, breaking resistance on heavy volume."',
        expected_signal="NVDA",
    ),
    BenchmarkTask(
        id="classify_intent",
        kind="structured",
        prompt='Classify this support ticket into exactly one of: billing | bug | feature_request | account. Reply with only the label. Ticket: "My subscription renewed but I was charged twice this month."',
        expected_signal="billing",
    ),
    BenchmarkTask(
        id="summarize_one_line",
        kind="structured",
        prompt='Summarize in one sentence: "In Q3 2025, the company launched three new products, grew revenue 22% YoY to $1.4B, opened two new data centers in Asia, and announced a $200M buyback program."',
        expected_signal="Q3",
    ),
    BenchmarkTask(
        id="extract_params_json",
        kind="structured",
        prompt='Given these trading constraints — RSI between 35 and 65, stop loss 4%, take profit 12% — output as JSON matching the schema {"rsi_min": int, "rsi_max": int, "stop_loss": float, "take_profit": float}.',
        expected_signal='"rsi_min"',
    ),
    BenchmarkTask(
        id="extract_entities",
        kind="structured",
        prompt='Extract all company tickers mentioned as a JSON array: "AAPL outperformed MSFT this quarter while TSLA lagged, though NVDA remained the standout in the sector."',
        expected_signal="AAPL",
    ),
    BenchmarkTask(
        id="sentiment_score",
        kind="structured",
        prompt='Return only a single float between -1.0 (very negative) and 1.0 (very positive) representing sentiment of: "The earnings miss was brutal and guidance was cut sharply."',
        expected_signal="-",  # expect negative
    ),
    BenchmarkTask(
        id="sql_from_request",
        kind="structured",
        prompt='Write a single PostgreSQL SELECT query returning the top 5 users by total_spend in the last 30 days from a table "orders(user_id, amount, created_at)". Output only the SQL.',
        expected_signal="GROUP BY",
    ),
    BenchmarkTask(
        id="regex_compile",
        kind="structured",
        prompt='Return only a Python regex pattern (no explanation) that matches a US phone number in format (XXX) XXX-XXXX.',
        expected_signal=r"\(",
    ),
    BenchmarkTask(
        id="code_to_docstring",
        kind="structured",
        prompt='Write a one-line docstring for this function: `def merge_sorted(a, b): r = []; i = j = 0; ...`',
        expected_signal="merge",
    ),
    BenchmarkTask(
        id="translate",
        kind="structured",
        prompt='Translate only the following sentence to Japanese, output only the translation: "The meeting has been rescheduled to Thursday at 3 PM."',
        expected_signal="",  # any non-empty translation
    ),
]


REASONING_TASKS: list[BenchmarkTask] = [
    BenchmarkTask(
        id="critique_strategy",
        kind="reasoning",
        prompt='Review this trading strategy and name three specific weaknesses with concrete scenarios where each fails: "Buy when RSI < 30, sell when RSI > 70, hold otherwise. No stops. No position sizing."',
        expected_signal="whipsaw",
    ),
    BenchmarkTask(
        id="architecture_tradeoff",
        kind="reasoning",
        prompt='A new service needs to store 50M records, serve 8k reads/sec and 400 writes/sec with p99 < 80ms. Queries are user_id + date range. Team has strong Postgres experience, minimal DynamoDB. Recommend one with reasoning, then name the single strongest counter-argument.',
        expected_signal="Postgres",
    ),
    BenchmarkTask(
        id="pr_merge_decision",
        kind="reasoning",
        prompt='Should you merge this PR today? 340 LOC diff touching auth middleware, 85% test coverage, author has 3 weeks tenure, production traffic is 2400 QPS. Give a decision (MERGE/DEFER/REJECT), confidence, and what single piece of evidence would flip your call.',
        expected_signal="DEFER",  # sensible default
    ),
    BenchmarkTask(
        id="debug_reasoning",
        kind="reasoning",
        prompt='A Python service runs fine for hours then suddenly stops responding. CPU is low, memory is stable, no errors logged. Restarting fixes it. Name three plausible root causes ranked by likelihood, and the first diagnostic to run for each.',
        expected_signal="thread",
    ),
    BenchmarkTask(
        id="pricing_strategy",
        kind="reasoning",
        prompt='A B2B SaaS is stuck at $20k MRR for six months with 40% churn at month 3. The product works. Name the three most likely root causes and the experiment to validate each. Rank by expected information gain.',
        expected_signal="onboarding",
    ),
    BenchmarkTask(
        id="code_review_judgment",
        kind="reasoning",
        prompt='This function uses `eval(user_input)` to compute a math expression. The input is validated by a regex to contain only digits and operators. Is this safe? Explain the exact attack vector if it is not, or the exact property that makes it safe if it is.',
        expected_signal="not safe",
    ),
    BenchmarkTask(
        id="hiring_call",
        kind="reasoning",
        prompt='A senior candidate: strong technical signal, awkward team interactions during panel, explicit about wanting to work alone. Growth-stage startup, 15 engineers. Should you hire? Give your decision, the single biggest risk, and the one piece of follow-up data you would seek.',
        expected_signal="risk",
    ),
    BenchmarkTask(
        id="migration_plan",
        kind="reasoning",
        prompt='You need to migrate a 50M-row Postgres table to add a NOT NULL column with a default. The table is under constant write load. Describe the migration in ordered steps, flag the one step that can break production, and name the safeguard.',
        expected_signal="lock",
    ),
    BenchmarkTask(
        id="feature_scope",
        kind="reasoning",
        prompt='A PM asks for "AI-powered search" in the next sprint. The real user pain is that search returns too many irrelevant results. What do you actually build, and what do you explicitly NOT build?',
        expected_signal="ranking",
    ),
    BenchmarkTask(
        id="ml_problem_framing",
        kind="reasoning",
        prompt='A team wants to use a deep neural net to predict customer churn. They have 8000 labeled examples and 40 features. Is this the right tool? Name the better option and why, or confirm DL fits and why.',
        expected_signal="gradient",
    ),
]


ALL_TASKS: list[BenchmarkTask] = STRUCTURED_TASKS + REASONING_TASKS
