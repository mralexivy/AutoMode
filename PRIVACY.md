# Privacy

AutoMode for Claude Code runs on your machine. It has no server and no account, and it collects no telemetry. Nobody, including the authors, receives your data from AutoMode.

## What leaves your machine

AutoMode has no network code of its own. Its model calls go through Claude Code, on your own Claude login, to the same provider as the rest of your session and under the same terms:

- **The judges.** For each new prompt, AutoMode makes 2 to 4 short Haiku calls to pick a route: the AutoMode judge, 1 or 2 effortless judge calls, and sometimes 1 more. A pinned model makes 2. A short follow-up, or a prompt whose verdict is cached, makes none. A subagent spawn makes 1 call, and a plan-mode change makes 2 to 4. A failed call can be retried once or twice. Each call holds your prompt text, a short part of the last reply, and state lines about the session.
- **Compaction.** Every compaction of the main session, `/compact` included, is written by Haiku, so the chat text goes to that model. The guardian also queues a compaction by itself when it pays (`autoCompact`, on by default).
- **Delegated reads.** With `delegation: on`, each `extract` call sends the named files and one question to Haiku. It is off by default, and it reads only files your Read permissions allow.
- **The workflow agents.** They run as ordinary Claude Code subagents.

## What AutoMode stores

Everything is in `~/.claude/plugins/data/automode/`, on your machine.

| Data | Holds | Kept for |
|---|---|---|
| `learned-<project hash>.json` | Route learning: task ids, tier and model labels, outcomes, times. No prompt text. | Until you delete it. It keeps the last 200 tasks. |
| `records/` | Routing decisions and outcomes: ids, labels, tokens, costs. No prompt text. | Until you delete it. A file rotates at 10 MB. |
| `guardian/` | Guardian events: ids, labels, numbers and the paths of saved outputs. | 30 days |
| `checkpoints/` | The task state for a handoff after `/clear`: the first 500 characters of your request, file paths, check commands, the git branch and the changed files. | 7 days |
| `outputs/` | The full text of long tool outputs that the guardian shortened. | 3 days |
| `habits.json` | The return model: for each idle gap that ended, a few numbers (the chat's size, the session's age, how many prompts you typed, how much the assistant wrote since the last one, whether it ended on a question, and whether you came back within the hour), the fitted weights, the model's report card, and the keep-warm ledger and race. No text, no paths, no times of day. Under 20 KB. | Until you delete it or reset. It keeps the last 400 points, and the ledger fades with a 30-day half-life. |
| `first-prefix.json`, `calibration.json` | Prompt cache sizes per project, and your own calibration. | Until you delete them. |

**Reading your history.** Without it the model still learns from sessions it watches live, from the same numbers. Reading your past sessions is off by default. After you run `/automode learned import` (or set `cacheKeeper.learnFromHistory`), AutoMode reads your own Claude Code transcripts, `~/.claude/projects/*/*.jsonl` in every project, in the background and a few files at a time, to fill `habits.json`. It parses each file in memory and keeps only request times, sizes, how many prompts you typed, how much the assistant wrote since the last one, whether a reply ended on a question (a yes or no read from the text and then dropped), and which Claude Code surface wrote the file. It does not store or send prompt or reply text, and the counts never leave your machine. A transcript too large to read whole goes through `scripts/habits-fold.mjs` in your own `node`, which prints only those numbers. `/automode learned` shows the result, and `/automode learned reset` clears it and turns reading off.

The guardian removes secret-shaped text from checkpoints and from check commands before it stores them. Files in `outputs/` hold the raw output, so they can hold whatever the command printed. AutoMode sets the guardian's records and checkpoints to owner-only access where the system allows it.

With `debugLog` on, AutoMode also writes `judge-log.jsonl` in the plugin folder. It is off by default.

## Remove your data

Delete `~/.claude/plugins/data/automode/`. To stop AutoMode from recording decisions, set `"recordDecisions": false` in your `config.json`.

## Questions

Open an [issue](https://github.com/mralexivy/AutoMode/issues). To report a security problem, follow [SECURITY.md](SECURITY.md).
