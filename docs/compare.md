# How AutoMode compares

Four routers for Claude Code. Feature rows come from each project's README, read on 2026-10-30. The cost rows come from our own benchmark run on 2026-11-04. These projects change quickly, so check their pages too. If a cell is wrong, [open an issue](https://github.com/mralexivy/AutoMode/issues).

AutoMode is not independent of these projects. Its effort rules and bar techniques are ported from effortless, and its classifier contract and switch payback are adapted from claude-router and jev-router. See [Credits](../README.md#credits).

| | AutoMode | [effortless](https://github.com/HeyCubit/effortless) | [jev-router](https://github.com/gargpratyush/jev-router) | [claude-router](https://github.com/alexei-led/claude-router) |
|---|---|---|---|---|
| **Effort per prompt** | Yes | Yes | Not described | Yes |
| **Model per prompt** | Yes, on by default | Off by default, marked experimental | Yes | Yes |
| **Extra credential** | None | None. A Jev key is optional. | Jev key | Depends on the classifier. Ollama needs none. |
| **How it runs** | Claude Code mod | Claude Code mod | Local proxy around the CLI | Claude Code mod |
| **CLIs** | Claude Code | Claude Code | Claude Code and Codex | Claude Code |
| **Multi-stage workflow** | Plan, build, verify, review | Not described | Not described | Not described |
| **Mandatory review for risky work** | Yes. Opus when the diff shows critical risk | Not described | Not described | Not described |
| **Prompt cache** | Countdown on the bar, cost check before a switch | Countdown on the bar, compact and handoff offers | Refuses a downgrade that wastes more cache than it saves | Cache-cost rules in its policy |
| **Cost result** | **Measured: 51% less than Opus** in mixed sessions, 45% less on 30 coding tasks, same pass rate | Measured by us: 7% less than Opus in the same sessions. Its own: 21% less than Opus medium, on mostly easy tasks | None found | "Savings are not measured" |

"Not described" means the README does not mention it. It does not prove the feature is absent.

## Measured on the same sessions

Five mixed sessions on real repositories, 20 steps per arm: questions and coding tasks in one continuing conversation, graded by hidden tests. Sessions were launched on Opus, as most people run Claude Code. effortless ran at its pinned commit, as its author ships it. Costs are list-price equivalents of every paid request.

| Arm | Passed | Questions | Coding tasks | Total | vs Opus |
|---|---|---|---|---|---|
| **AutoMode** | **20/20** | **$0.08** | $1.93 | **$2.01** | **−51%** |
| Plain Sonnet high | 20/20 | $0.24 | $1.90 | $2.14 | −48% |
| effortless, on Opus | 20/20 | $0.43 | $3.44 | $3.87 | −7% |
| Plain Opus | 20/20 | $0.50 | $3.64 | $4.14 | — |

effortless sets the effort and keeps the model. AutoMode also routes the model: questions go to Haiku and coding to Sonnet. jev-router and claude-router were audited from source, not run ([method](../bench/external/METHODOLOGY.md)). The full report, with the 30-task run and the limits, is [`bench/experiments/V6.md`](../bench/experiments/V6.md).

## Other tools with similar names

Read on 2026-10-31.

- **[ClaudeRouter](https://github.com/0dust/ClaudeRouter)** classifies each prompt and delegates to Haiku, Sonnet or Opus. It installs from npm, and its README lists a Pro or Max plan as a requirement for delegation.
- **[claude-model-router](https://github.com/jdogresorg/claude-model-router)** tracks token use and routes sub-tasks to subagents, rather than the main prompt.
- **[Claude Code Router](https://github.com/musistudio/claude-code-router)** does a different job. It connects coding agents to the providers you choose, then routes and fails over between them.

## Where the others are ahead

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

**When a task fails mid-way.** Under the default strategy, `v6c`, AutoMode no longer moves a large failed conversation to a pricier model. A fresh builder takes over instead, with a brief of the task, the corrections and what already failed. In an earlier version, six such switches cost $8.18 more than Sonnet high on the same tasks.

**What the benchmark shows.** These gates and the fresh builder are why AutoMode costs 51% less than Opus in mixed sessions. They do not make it cheaper than Sonnet high on long single coding tasks, where it costs about 15% more. See [Benchmarks](../README.md#benchmarks).

To route effort only and keep the model you picked, run `/plugin configure automode@automode` and set **Route models** to `off`.
