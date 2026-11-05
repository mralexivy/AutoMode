---
channel: bluesky
status: draft
date: 2026-11-16
assets: [site/public/video/benchmark-race.mp4]
---
Same 5 Claude Code sessions, four setups, every step checked by hidden tests:

Opus (default) $4.14
effortless on Opus $3.87
Sonnet high $2.14
AutoMode $2.01

All passed 20/20. AutoMode is my open source mod that picks the model and effort per prompt 🧵
<!-- next -->
The trick is boring: a quick question doesn't need Opus. Haiku answers it, Sonnet does the edits, Opus gets design and risky work. A risk floor in code keeps migrations and auth changes off Haiku.
<!-- next -->
Where it doesn't win: long coding tasks with no questions. There it costs about what Sonnet high costs. If you already live on Sonnet high, you'll save little. I'd rather say that up front.
<!-- next -->
Free, MIT, no key, no server.

/plugin marketplace add mralexivy/AutoMode

The benchmark, with rows you can rerun: https://mralexivy.github.io/AutoMode/benchmark/
