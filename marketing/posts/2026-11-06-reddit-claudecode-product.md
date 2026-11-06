---
note: "Removed on submit because the account has 1 karma. Modmail sent 2026-11-06."
url: https://www.reddit.com/r/ClaudeCode/comments/1xpc7an/i_built_automode_a_claude_code_mod_that_picks_the/
channel: reddit
status: sent
date: 2026-11-06
subreddit: r/ClaudeCode
flair: Built with Claude
title: "I built AutoMode, a Claude Code mod that picks the model and effort for every prompt and runs big jobs with specialized subagents"
assets: [marketing/assets/automode-slide-1.png, marketing/assets/automode-slide-2.png, marketing/assets/automode-slide-3.png, marketing/assets/automode-slide-4.png]
---
I got tired of switching `/model` and `/effort` by hand, so I built AutoMode, a free, MIT-licensed Claude Code mod that does it for every prompt. I'm the author.

**What it does in a session**

- **Picks the model and effort per prompt.** Two Haiku judges read each prompt. A quick question runs on Haiku at low effort, an edit on Sonnet, design and risky work on Opus. Effort can change while the model holds, so the cache stays warm.
- **Shows you why.** A bar above the prompt shows the model, effort, context use, the prompt-cache countdown, the reason for the route, and an estimated saving. `/automode details` prints every decision.
- **Keeps risky work off small models.** A risk floor in code (auth, migrations, data deletion) can't be lowered by the judge, and risky changes always get an independent review.
- **Checks the cache before a switch.** A model switch mid-chat rewrites the whole chat into the new model's cache, so it only switches when the saving pays that back.
- **Runs big jobs as a team.** `am:run <task>` starts six specialized subagents: Haiku explorers discover the code, an Opus architect plans, Sonnet implementers build only their own files, a verifier lets exit codes decide, and an Opus reviewer reads the diff.
- **Guards the session.** It redacts secret-shaped text, shortens huge tool output, saves a task checkpoint, and blocks git writes and `rm -rf` from subagents.

No API key and no server. It runs on your Claude login.

```
/plugin marketplace add mralexivy/AutoMode
/plugin install automode@automode
/reload-plugins
```

**How Claude Code was used.** I built AutoMode with Claude Code. Claude wrote most of the routing code, the subagents and the benchmark harness, and it ran the benchmark sessions as the agent under test. I reviewed every change and fixed each pass rule before its run.

**What I learned.** My first benchmark showed AutoMode costing more than plain Opus, because one rule sent hard tasks straight to Opus. Now hard work starts on Sonnet and earns Opus with evidence: a failing check or a reviewer blocking the change. On 5 mixed sessions graded by hidden tests, AutoMode cost $2.01, Sonnet high $2.14, effortless $3.87 and plain Opus $4.14, all 20/20. On long tasks with no questions it costs about what Sonnet high costs, so it won't save you much there.

Repo: https://github.com/mralexivy/AutoMode · Docs: https://mralexivy.github.io/AutoMode/docs/

Happy to answer anything about how the routing decides.

#ClaudeCode #ClaudeCodePlugin #ClaudeCodeMod #AutoMode
