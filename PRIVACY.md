# Privacy

AutoMode for Claude Code runs on your machine. It has no server and no account, and it collects no telemetry. Nobody, including the authors, receives your data from AutoMode.

## What leaves your machine

AutoMode has no network code of its own. Its model calls go through Claude Code, on your own Claude login, to the same provider as the rest of your session and under the same terms:

- **The judges.** For each prompt, AutoMode calls Haiku to pick a route. The call holds your prompt text, a short part of the last reply, and state lines about the session.
- **Compaction.** When AutoMode compacts a chat on Haiku, the chat text goes to that model.
- **The workflow agents.** They run as ordinary Claude Code subagents.

## What AutoMode stores

Everything is in `~/.claude/plugins/data/automode/`, on your machine.

| Data | Holds | Kept for |
|---|---|---|
| `records/` | Routing decisions and outcomes: ids, labels, tokens, costs. No prompt text. | Until you delete it. A file rotates at 10 MB. |
| `guardian/` | Guardian events: ids, labels, numbers and the paths of saved outputs. | 30 days |
| `checkpoints/` | The task state for a handoff after `/clear`: the first 500 characters of your request, file paths, check commands, the git branch and the changed files. | 7 days |
| `outputs/` | The full text of long tool outputs that the guardian shortened. | 3 days |
| `first-prefix.json`, `calibration.json` | Prompt cache sizes per project, and your own calibration. | Until you delete them. |

The guardian removes secret-shaped text from checkpoints and from check commands before it stores them. Files in `outputs/` hold the raw output, so they can hold whatever the command printed. AutoMode sets the guardian's records and checkpoints to owner-only access where the system allows it.

With `debugLog` on, AutoMode also writes `judge-log.jsonl` in the plugin folder. It is off by default.

## Remove your data

Delete `~/.claude/plugins/data/automode/`. To stop AutoMode from recording decisions, set `"recordDecisions": false` in your `config.json`.

## Questions

Open an [issue](https://github.com/mralexivy/AutoMode/issues). To report a security problem, follow [SECURITY.md](SECURITY.md).
