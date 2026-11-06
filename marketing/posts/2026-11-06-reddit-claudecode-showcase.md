---
url: https://www.reddit.com/r/ClaudeCode/comments/1xlurut/weekly_showcase_thread_what_are_you_building_with/19s880oecd0w3/
channel: reddit
status: sent
date: 2026-11-06
subreddit: r/ClaudeCode weekly showcase thread
---
**AutoMode**: a free, MIT-licensed Claude Code mod that picks the model and effort for every prompt. I'm the author.

- Two Haiku judges read each prompt. A quick question runs on Haiku at low effort, an edit on Sonnet, design and risky work on Opus.
- A bar above the prompt shows the model, effort, context, the cache countdown and why it picked that route. `/automode details` prints every decision.
- A risk floor in code keeps auth, migrations and data deletion off small models, and risky changes always get a review.
- It checks the prompt-cache cost before switching models mid-chat, and holds when the switch wouldn't pay back.
- `am:run <task>` runs big jobs with specialized subagents: Haiku explorers, an Opus architect, Sonnet builders, a verifier where exit codes decide, and an Opus reviewer.

**How I used Claude Code:** it wrote most of the routing code, the subagents and the benchmark harness, and it ran the benchmark sessions as the agent under test. I reviewed each change.

**What I learned:** my first benchmark lost to plain Opus, because one rule sent hard tasks straight to Opus. Now hard work starts on Sonnet and earns Opus with evidence. On 5 mixed sessions graded by hidden tests it cost $2.01, against $2.14 on Sonnet high, $3.87 with effortless and $4.14 on plain Opus, all 20/20. On long tasks alone it costs about what Sonnet high costs.

```
/plugin marketplace add mralexivy/AutoMode
/plugin install automode@automode
```

https://github.com/mralexivy/AutoMode
