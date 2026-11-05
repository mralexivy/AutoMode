---
channel: reddit
status: draft
date: 2026-11-17
title: "I measured what my Claude Code sessions cost on Opus vs. letting a router pick the model per prompt"
subreddit: r/ClaudeAI
---
Disclosure first: I built the tool in this post. It's free and MIT, with nothing to buy.

I kept noticing that most of my Claude Code sessions are a quick question, then a real task, then another question, then a harder task. And all of it runs on Opus because that's the default. So I wrote a mod, AutoMode, that picks the model and effort for each prompt, and then tried to measure honestly whether it helps.

**Same 5 mixed sessions, 20 steps, every step graded by hidden tests:**

| Setup | Passed | Cost |
|---|---|---|
| Claude Code on Opus (default) | 20/20 | $4.14 |
| effortless on Opus | 20/20 | $3.87 |
| Plain Sonnet high | 20/20 | $2.14 |
| AutoMode | 20/20 | $2.01 |

Most of the gap is the questions. Haiku answered them for $0.08 in total, against $0.50 on Opus.

**Where it doesn't help:** on long coding tasks with no questions in between, AutoMode ends up on Sonnet and costs about 15% more than plain Sonnet high, because of its judge calls. If you already run Sonnet high and only do long tasks, skip it.

Costs are list-price equivalents, not what a Pro or Max plan bills. Each setup ran once.

I also put a calculator on the site where you enter your own weekly mix of questions and tasks: https://mralexivy.github.io/AutoMode/calculator/

Install inside Claude Code:

```
/plugin marketplace add mralexivy/AutoMode
/plugin install automode@automode
```

Rows, method and the command to reproduce it: https://mralexivy.github.io/AutoMode/benchmark/

Curious what your mix looks like. Is it mostly long tasks, or lots of small questions?
