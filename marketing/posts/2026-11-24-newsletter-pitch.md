---
channel: newsletter
status: draft
date: 2026-11-24
---
Subject: A Claude Code router that published the run where it lost

Hi,

I'm the author of AutoMode, a free, MIT-licensed Claude Code mod that picks the model and reasoning effort for each prompt. I think your readers might like the benchmark story more than the tool.

The first 30-task run, graded by hidden tests, showed AutoMode costing more than plain Opus. I found the rule responsible, fixed it, and reran under pass rules committed in advance. On 5 mixed sessions it now costs $2.01 against $4.14 on plain Opus, with every step passing. Both runs are public, along with the case where it still loses: long tasks on Sonnet high.

Write-up and rows: https://mralexivy.github.io/AutoMode/benchmark/
Code: https://github.com/mralexivy/AutoMode

Happy to answer questions or write a short guest piece on measuring AI coding tools.

Thanks,
Alex
