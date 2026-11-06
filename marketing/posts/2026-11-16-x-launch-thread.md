---
note: "Deleted 2026-11-06 after no engagement. Replaced by 2026-11-06-x-product-thread.md."
url: https://x.com/mr_alexivy/status/2118400494385107363
channel: x
status: sent
date: 2026-11-05
assets: [site/public/video/benchmark-race.mp4]
---
I ran the same 5 Claude Code sessions four ways, every step graded by hidden tests.

Opus (the default): $4.14
effortless on Opus: $3.87
Sonnet high: $2.14
AutoMode: $2.01

All four passed 20/20. Here's what AutoMode does differently 🧵
<!-- next -->
Most of my Claude Code sessions are a mix: a quick question, a real task, another question, a harder task.

Running all of that on Opus is like taking a taxi to the mailbox. The questions alone cost $0.50 on Opus. AutoMode paid $0.08 for the same answers.
<!-- next -->
AutoMode is a free, open source Claude Code mod. Each prompt gets a model and an effort:

quick fact → Haiku
an edit → Sonnet
design or risky work → Opus

A code-set risk floor means a migration or an auth change never lands on Haiku.
<!-- next -->
The honest part: on long coding tasks with no questions in between, it costs about what Sonnet high costs. If that's all you do and you already run Sonnet high, you'll save little.

It wins where most people are: Claude Code on Opus, mixing questions and work.
<!-- next -->
The first version of this benchmark actually showed AutoMode costing MORE than Opus. A rule sent half the hard tasks to Opus. I fixed it, reran, and published both runs.

30 coding tasks now: 29/30 passed, 45% cheaper than Opus per passed task.
<!-- next -->
No API key, no server. It runs on your Claude login.

/plugin marketplace add mralexivy/AutoMode
/plugin install automode@automode

Benchmark, rows and the reproduce command: https://mralexivy.github.io/AutoMode/benchmark/

Code: https://github.com/mralexivy/AutoMode
