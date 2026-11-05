---
channel: reddit
status: draft
date: 2026-11-20
title: "My Claude Code bar now tells me what each session saved. Here's how the estimate works"
subreddit: r/ClaudeCode
assets: [site/public/video/terminal-demo.mp4]
---
I'm the author of AutoMode, an open source mod that routes each prompt to Haiku, Sonnet or Opus. The latest release puts an estimated saving on the status bar, and the way it's computed felt worth sharing, because the naive version lies.

**The naive version:** price each request on the model it ran on and on the model you started with, then subtract. That overstates the saving, because a model switch isn't free. The new model has to write the whole conversation into its own prompt cache first.

**What the bar does instead:**

- Before any prompt moves to another model, it shows nothing.
- Right after a switch it shows `↺ $X to pay back`, where X is the cost of that cache rewrite.
- Once cheaper requests have paid that off, it shows `saved ~$Y`.
- AutoMode's own calls (the judge, extracts, compaction) count against the saving.
- `/automode details` prints every part of the sum.

The baseline keeps its own warm cache, so the comparison isn't rigged against Opus.

On our public benchmark of 5 mixed sessions, AutoMode cost $2.01 against $4.14 on Opus, all 20/20. On long tasks with no questions it costs about what Sonnet high costs, so don't expect much there.

If you try it, I'd love to see what your bar says after a normal day. Post the line, good or bad.

https://github.com/mralexivy/AutoMode
