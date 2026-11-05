---
channel: discord
status: draft
date: 2026-11-20
assets: [site/public/video/terminal-demo.mp4]
---
**AutoMode**: a free, open source Claude Code mod that picks the model and effort for each prompt (I'm the author).

Quick question → Haiku, edit → Sonnet, design or risky work → Opus. A risk floor keeps migrations and auth off Haiku, and it checks the prompt-cache cost before switching models mid-chat.

On 5 mixed benchmark sessions it cost $2.01 against $4.14 on plain Opus, all 20/20. On long tasks with no questions it costs about what Sonnet high costs.

Install:
```
/plugin marketplace add mralexivy/AutoMode
/plugin install automode@automode
/reload-plugins
```
Benchmark: https://mralexivy.github.io/AutoMode/benchmark/
