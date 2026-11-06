---
url: https://dev.to/alexivy/automode-a-claude-code-mod-that-picks-the-model-and-effort-for-every-prompt-2f0p
channel: devto
status: sent
date: 2026-11-06
title: "AutoMode: a Claude Code mod that picks the model and effort for every prompt"
tags: [claudecode, ai, opensource, productivity]
cover: marketing/assets/automode-cover.png
assets: [marketing/assets/automode-slide-1.png, marketing/assets/automode-slide-2.png, marketing/assets/automode-slide-3.png, marketing/assets/automode-slide-4.png]
---
If you use Claude Code every day, you know the routine. You ask a quick question on Opus because that's the default. You switch to Sonnet for a big edit, forget to switch back, then wonder why a one-line answer took that long and cost that much.

I built **AutoMode** to stop doing that by hand. It's a free, MIT-licensed Claude Code mod that picks the model and the reasoning effort for every prompt, explains each choice, and runs big jobs with a team of specialized subagents.

{{IMG1}}

## One prompt, one route

Two small Haiku judges read each prompt before it runs. They estimate how hard the task is and what it needs. AutoMode then picks the cheapest model and effort that can still do the job well:

- **"what does -r do in cp?"** runs on Haiku at low effort. It's a quick fact.
- **"rename getUser to fetchUser everywhere"** runs on Sonnet at medium effort. It's a clear, mechanical edit.
- **"move sessions from cookies to signed JWTs"** runs on Opus at high effort. It's security and a migration, so a risk floor in code rules out the small models.

The route is picked fresh for every prompt. Effort can change while the model stays the same, which keeps the prompt cache warm.

## Every route, explained above your prompt

{{IMG2}}

A bar above the prompt shows what AutoMode decided and why: the model, the effort, how much context you've used, the prompt-cache countdown, the reason for the route, and an estimated saving against the model you started on. `/automode details` prints every decision as text.

The cache part matters more than it looks. Each model keeps its own prompt cache, so switching models in a long chat means rewriting the whole conversation into the new model's cache. AutoMode prices that rewrite before any switch, and it holds the current model when the switch wouldn't pay for itself.

## Big jobs get a team of subagents

{{IMG3}}

For open-ended work, `am:run <task>` starts a plan, build, verify and review workflow with specialized subagents, each on the model that fits its job:

- **Discover:** scoped Haiku explorers read the codebase in parallel.
- **Plan:** an Opus architect splits the work and sets the checks.
- **Build:** Sonnet implementers each own only their files.
- **Verify:** exit codes decide whether it works, not the model's word.
- **Review:** an independent Opus reviewer reads the diff.

A risk floor in code means auth changes, migrations and data deletion never land on a small model, and risky work always gets a review. A guardian also watches the session: it redacts secret-shaped text before it's stored, shortens huge tool output, saves task checkpoints, and blocks git writes and `rm -rf` from subagents.

## Does it save money?

{{IMG4}}

It depends on how you work, so here's what we measured. Five mixed sessions, the way most of us actually use Claude Code: a question, a task, another question, a harder task. Every step was graded by hidden tests, and every request was counted at list price, judges included.

| Setup | Passed | Cost |
|---|---|---|
| **AutoMode** | **20/20** | **$2.01** |
| Plain Sonnet high | 20/20 | $2.14 |
| effortless, on Opus | 20/20 | $3.87 |
| Claude Code on Opus (the default) | 20/20 | $4.14 |

That's 51% less than Claude Code on Opus and 48% less than effortless, with every step still passing. Most of the gap is the questions: Haiku answered them for $0.08 in total, against $0.50 on Opus.

Where it doesn't win: on long coding tasks with no questions in between, AutoMode runs on Sonnet and costs about what plain Sonnet high costs. If that's your whole day, you'll save little. The method, the rows and the command to reproduce them are on the [benchmark page](https://mralexivy.github.io/AutoMode/docs/benchmarks/results/).

## Try it

It needs no API key and no server. It runs on your own Claude login. Inside Claude Code:

```
/plugin marketplace add mralexivy/AutoMode
/plugin install automode@automode
/reload-plugins
```

Then just work. Ask a question, make an edit, start a migration, and watch the bar.

I built AutoMode with Claude Code itself, and I'd love feedback, especially from people whose workload breaks my numbers.

- Code: https://github.com/mralexivy/AutoMode
- Docs: https://mralexivy.github.io/AutoMode/docs/
