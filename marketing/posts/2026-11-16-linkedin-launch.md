---
url: https://www.linkedin.com/feed/update/urn:li:activity:7427031833260994560/
channel: linkedin
status: sent
date: 2026-11-05
assets: [site/public/video/benchmark-race.mp4]
---
My first benchmark said my own tool made things worse.

I've been building AutoMode, a free, open source add-on for Claude Code. It picks the model and the reasoning effort for every prompt, so a quick question doesn't burn Opus money and a risky migration doesn't land on a small model.

When I finally measured it properly, with 30 real coding tasks from public repositories and each one graded by hidden tests, AutoMode cost more than plain Opus. One rule sent half of the hard tasks straight to Opus, and plain Sonnet passed those same tasks for a fraction of the price.

So I changed the rule: hard work now starts on Sonnet, and Opus has to be earned by evidence, like a failing check or a reviewer blocking the change. Then I reran everything under pass rules I committed before the first row.

Where it landed:

• 5 mixed sessions (questions and coding, the way most of us actually work): $2.01 with AutoMode, against $4.14 on Opus, $3.87 with effortless and $2.14 on Sonnet high. Every setup passed 20 of 20.
• 30 single coding tasks: 29 of 30 passed, 45% cheaper than Opus per passed task.
• Where it does not win: long coding tasks with no questions cost about 15% more than plain Sonnet high. If that's your whole day, it isn't for you, and the README says so.

Three things I took away about benchmarking AI tools:

1. Fix your pass rule before you see any result. Otherwise you will find a reason to like the number.
2. Publish the run that embarrassed you. It's the most convincing part.
3. "It saves money" is never a full answer. "It saves money for this kind of usage" is.

It runs on your own Claude login, with no API key and no server. The benchmark rows and the command to reproduce them are public.

https://mralexivy.github.io/AutoMode/benchmark/

#ClaudeCode #OpenSource #AIEngineering #DeveloperTools
