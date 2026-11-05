---
channel: devto
status: draft
date: 2026-11-16
title: "My Claude Code router cost more than Opus. Here's what the benchmark taught me"
tags: [claudecode, ai, opensource, benchmark]
canonical: https://mralexivy.github.io/AutoMode/docs/benchmarks/results/
cover: site/public/video/benchmark-race.mp4
---
I built AutoMode because most of my Claude Code sessions look the same. I ask a quick question, then run a real task, ask another question, then do a harder task. And by default all of it runs on Opus.

AutoMode is a free, open source (MIT) Claude Code mod. For every prompt it picks a model and a reasoning effort: Haiku for a quick fact, Sonnet for an edit, Opus for design and risky work. It runs on your own Claude login, with no API key, no proxy and no server.

The idea is obvious. Proving that it helps was not. This is the story of the benchmark, including the run where my tool lost.

## How the benchmark works

I wanted numbers I'd trust if someone else had published them:

- **Real tasks.** Each task names a public repository, a pinned base commit and a pinned reference commit.
- **Hidden tests.** They go into the workspace only after the agent has saved its change. The agent never sees them.
- **All costs counted.** Costs are list-price equivalents of every request, AutoMode's own judge calls and subagents included.
- **Rules first.** The ship rule for each run is committed before its first row.
- **Sessions start on Opus,** because that's how most people run Claude Code.

## The first run went badly

On the first 30-task run, AutoMode cost *more* than plain Opus.

The cause was one rule. Whenever the judge rated a task as hard with critical risk, AutoMode started it on Opus. That sent half of the 30 tasks to Opus. Plain Sonnet high passed every one of those same tasks, far more cheaply.

The fix was to make Opus something a task earns. Hard work now starts on Sonnet high. Opus comes in only on evidence: a failing check, a regression, or a reviewer blocking the change. The hardest tier still starts on Opus.

I kept the losing run in the report. If a benchmark only shows wins, I assume someone tuned it until it did.

## Where it landed

**Five mixed sessions, 20 steps.** Each session runs in one continuing conversation: a question, a task, another question, a harder task.

| Setup | Passed | Total |
|---|---|---|
| **AutoMode** | **20/20** | **$2.01** |
| Plain Sonnet high | 20/20 | $2.14 |
| effortless, on Opus | 20/20 | $3.87 |
| Plain Opus (the default) | 20/20 | $4.14 |

That is 51% less than Opus and 48% less than effortless at the same pass rate. Most of the gap is the questions. Haiku answered them for $0.08 in total, against $0.50 on Opus.

**Thirty single coding tasks.**

| Setup | Passed | Cost per passed task |
|---|---|---|
| **AutoMode** | **29/30** | **$0.275** |
| Plain Opus | 28/30 | $0.499 |
| Plain Sonnet high | 30/30 | $0.240 |

The cost ratio against Opus is 0.551, with a 90% interval of 0.511 to 0.591.

## Where it does not win

No router wins every workload, so here is where AutoMode doesn't:

- **Long coding tasks with no questions.** AutoMode runs these on Sonnet, so it costs about what Sonnet high costs, plus its judges and checks. That comes to about 15% more. If that's your whole day and you already run Sonnet high, it saves you little.
- **Each arm ran once.** Treat this as a release signal, not a general law.
- **These are list prices.** On a Pro or Max plan you aren't billed per request, so read these numbers as relative cost.

## Two engineering details that mattered

**Model switches aren't free.** Each model keeps its own prompt cache. A switch in a warm chat makes the new model write the whole conversation into its cache. AutoMode prices that rewrite before any switch, and it holds the current model when the saving wouldn't pay the rewrite back. The site has a chart where you can watch a switch pay back: https://mralexivy.github.io/AutoMode/calculator/

**A risk floor in code.** Migrations, auth changes, data deletion and similar work have a quality floor that the judge can't lower. Risky work always gets an independent review.

## Try it, or check my numbers

Install inside Claude Code:

```
/plugin marketplace add mralexivy/AutoMode
/plugin install automode@automode
/reload-plugins
```

The bar then shows the route for each prompt, the cache countdown and an estimated saving against the model you started on.

The rows, the method and the command to reproduce the decision are public: https://mralexivy.github.io/AutoMode/benchmark/

The code is at https://github.com/mralexivy/AutoMode. If your workload breaks my numbers, I'd like to see it. Benchmark tasks are the most useful contribution.
