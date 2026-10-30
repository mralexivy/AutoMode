# How AutoMode compares

Four routers for Claude Code, as each project describes itself. Read from each project's README on 2026-10-30. These projects change quickly, so check their pages too. If a cell is wrong, [open an issue](https://github.com/mralexivy/AutoMode/issues).

AutoMode is not independent of these projects. Its effort rules and bar techniques are ported from effortless, and its classifier contract and switch payback are adapted from claude-router and jev-router. See [Credits](../README.md#credits).

| | AutoMode | [effortless](https://github.com/HeyCubit/effortless) | [jev-router](https://github.com/gargpratyush/jev-router) | [claude-router](https://github.com/alexei-led/claude-router) |
|---|---|---|---|---|
| **Effort per prompt** | Yes | Yes | Not described | Yes |
| **Model per prompt** | Yes, on by default | Off by default, marked experimental | Yes | Yes |
| **Extra credential** | None | None. A Jev key is optional. | Jev key | Depends on the classifier. Ollama needs none. |
| **How it runs** | Claude Code mod | Claude Code mod | Local proxy around the CLI | Claude Code mod |
| **CLIs** | Claude Code | Claude Code | Claude Code and Codex | Claude Code |
| **Multi-stage workflow** | Plan, build, verify, review | Not described | Not described | Not described |
| **Mandatory review for risky work** | Yes, Opus | Not described | Not described | Not described |
| **Prompt cache** | Countdown on the bar, cost check before a switch | Countdown on the bar, compact and handoff offers | Refuses a downgrade that wastes more cache than it saves | Cache-cost rules in its policy |
| **Published cost result** | **No** | **Yes.** 21% less than Opus medium, on mostly easy tasks. Its README gives the limits. | None found | "Savings are not measured" |

"Not described" means the README does not mention it. It does not prove the feature is absent.

## Where the others are ahead

- **effortless has a cost result.** AutoMode does not. We will not quote a saving until a public run produces one. See [Benchmarks](../README.md#benchmarks).
- **effortless is simpler.** It does one job.
- **jev-router also runs on Codex.** AutoMode runs only in Claude Code.
- **claude-router lets you choose the classifier,** including a local Ollama model. AutoMode's judge always runs on Haiku, through your Claude login.

## Does switching models waste the prompt cache?

It can. Each model keeps its own prompt cache, so a switch in a warm chat writes the whole chat to the new model's cache. The effortless README reports about 5 times the cost of staying on a warm Opus in an 80k-token chat, and for that reason it ships model switching off.

AutoMode switches models by default, so it checks each switch first. The check is in [`hooks/lib/policy.ts`](../hooks/lib/policy.ts). The route holds unless the switch passes:

| Situation | Rule |
|---|---|
| Risk floor | A mandatory floor always switches, whatever it costs. Quality comes first. |
| No warm cache | At session start, after `/clear`, or on a cold cache, there is little to lose, so a switch is allowed. |
| Moving up | Needs two votes in a row, unless the chat is under 20k tokens. |
| Moving down in a warm chat | No risk flagged, and judge confidence of at least 0.85. |
| Moving down in the same task | At least 8 requests since the last switch, and a passed check. |
| Moving down in a chat of 20k tokens or more | The cautious estimate of the saving must exceed 1.5 times the cache rewrite. |
| Too many switches | After 3 discretionary switches in one task, the route holds. |

**What this does not show.** These gates limit the cost of a switch. They do not prove that AutoMode saves money. The thresholds are defaults, not calibrated values, and the saving is an estimate. Only a public benchmark can settle it, and we do not have one yet.

To route effort only and keep the model you picked, run `/plugin configure automode@automode` and set **Route models** to `off`.
