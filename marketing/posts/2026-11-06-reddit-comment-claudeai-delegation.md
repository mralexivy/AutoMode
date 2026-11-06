---
channel: reddit
status: sent
date: 2026-11-06
subreddit: r/ClaudeAI
thread: https://www.reddit.com/r/ClaudeAI/comments/1xn0e12/
---
This matches what I found building a model router for Claude Code. My first version sent hard tasks to Opus up front and let cheaper models do the rest, and on 30 hidden-test tasks it cost *more* than plain Opus. Two changes fixed it:

1. **Don't split one task across models.** Every handoff writes the context into another model's cache, which is the "paying for the context write twice" mentioned above. I now price that rewrite before any switch and keep the current model when the switch won't pay back.
2. **Route by prompt, not by role.** The real savings were the boring prompts: quick questions and lookups on Haiku, edits on Sonnet. Hard work starts on Sonnet and only moves to Opus on evidence, like a failing check or a reviewer blocking the change.

On 5 mixed sessions (questions and coding in one conversation, every step graded by hidden tests) that came out at $2.01 against $4.14 on plain Opus, all 20/20. On long single tasks it costs about what Sonnet high costs, so it doesn't beat one good model there, which is your finding too.

Disclosure: it's my open source mod, AutoMode (MIT). The losing run is published next to the fix: https://github.com/mralexivy/AutoMode
