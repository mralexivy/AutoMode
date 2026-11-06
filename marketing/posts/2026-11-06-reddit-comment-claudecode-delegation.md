---
channel: reddit
status: sent
date: 2026-11-06
subreddit: r/ClaudeCode
thread: https://www.reddit.com/r/ClaudeCode/comments/1xn18cu/
---
Nice write-up. Your skill-routed setup costing more than forced Opus lines up with mine: subagent delegation mostly lost money, because the subagent has to rebuild context the main session already has cached.

What did save money was routing the main conversation itself, prompt by prompt. A quick question goes to Haiku, an edit to Sonnet, and only design or risky work to Opus, with a check before every model switch so a warm cache isn't thrown away. Effort is the cheaper lever, since changing it keeps the cache.

I put this into an open source Claude Code mod, AutoMode (I'm the author). On 5 mixed sessions graded by hidden tests it cost $2.01 against $4.14 on plain Opus, all 20/20. On long single tasks it's about Sonnet high cost. Method and rows, if you want to compare with your setup: https://mralexivy.github.io/AutoMode/docs/benchmarks/results/

If it's useful to you, a star helps other people find it: https://github.com/mralexivy/AutoMode
