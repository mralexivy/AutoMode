// effortless, ported verbatim. Source: https://github.com/HeyCubit/effortless at commit
// e5c590dfd9402244ea66a8bf795d1cb86d1df7b9 (2026-10-23, v1.72.0), file hooks/register.tsx.
// The vendored original and its sha256 are in bench/external/effortless/ (PROVENANCE.md).
//
// MIT License. Copyright (c) 2026 HeyCubit. The full license text is in ./LICENSE.effortless.
//
// Rules for this file:
//   - Every declaration below is copied from upstream without a change to its code. Only the type names are
//     local (upstream imports `Effort` and `ModelKey` from its own types/index.d.ts, which define them the same way).
//   - tests/effortless-fidelity.test.mts extracts each declaration from the vendored register.tsx and fails when
//     the code here differs from it (whitespace and comments aside).
//   - Changes AutoMode needs live in effortless-adapt.ts, never here, so this file stays comparable to upstream.
//   - Pure: no `$`, no I/O.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ModelKey = 'haiku' | 'sonnet' | 'opus' | 'fable'

export const MODELS: { key: ModelKey; label: string; long: string; id: string }[] = [
  { key: 'haiku', label: 'Haiku', long: 'Haiku 5.5', id: 'claude-haiku-5-5' },
  { key: 'sonnet', label: 'Sonnet', long: 'Sonnet 5.5', id: 'claude-sonnet-5-5' },
  { key: 'opus', label: 'Opus', long: 'Opus 5.5', id: 'claude-opus-5-5' },
  { key: 'fable', label: 'Fable', long: 'Fable 5.1', id: 'claude-fable-5-1' },
]
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// Changing effort between two requests keeps the prompt cache on these models only. On Fable 5.1 and older Opus
// the next request rewrote 56-100% of the cache (measured), which costs more than any effort can save.
export const cacheSafe = (modelId: string) => /(opus|sonnet)-5-5/.test(modelId)

export const JUDGE_SYSTEM = `You choose which Claude model and reasoning effort an agentic assistant (it reads files, runs tools and edits things, not only code) should use for the user's next message. Pick the cheapest pair that will still do the job well.

Models, cheapest first:
- haiku: quick questions, lookups, renames, small edits in one or two files, summaries, chit-chat. It can read files and run tools; pick it for any small, well-defined job.
- sonnet: normal coding, edits across a few files, explanations, writing.
- opus: hard debugging, architecture, large refactors, careful reviews.
- fable: the hardest long-horizon or research-level work.

Effort: low for quick answers, medium for normal work, high for hard problems, xhigh or max only for very hard ones.

Effort is relative to the model in use ("Current" names it): a stronger model needs less effort for the same job. Opus at medium does about what Sonnet does at high, and Fable is stronger again. So for one and the same task pick one step lower on Opus than on Sonnet, and lower still on Fable; on Sonnet, go one step higher for hard work than you would on Opus.

Judge the SCOPE and the amount of work, not whether it is code. A short message can ask for a lot: "go through my whole drive and clean it up", "review the entire repo", "migrate everything" are big, multi-step, tool-heavy jobs where mistakes are costly: never low, usually high. Low is only for answers that need no tools and no planning.

If the message answers a question in the assistant's last reply (picks an option, says which one, confirms a plan), judge only the work that answer starts, as the reply describes it, not the length of the answer and not the work done before the question: "B" can mean "build the complicated section B" (high), while "yes" or "no" to one small action ("should I archive this?", "delete the old ones too?") is low, and picking a value for one setting (a log level, a colour, a font) is low. But picking which way to build something ("option 1", "the same shapes", "B") starts that build: judge the build. Approving a whole plan or several steps takes the effort of that plan. A plain "yes", "ok" or "do it" after "Is that OK? Then I'll build X" or "Should I build X?" approves building X: judge X, not the word.

A message that pushes back on, corrects or adds to a plan or claim under discussion continues that work: keep at least the effort that work had, never drop to low for it. Thanks, praise or a closing remark with no new request is low. A question about how to do something, or about effort itself, that needs no tools is low.

If the person asks for deep thought ("think hard", "ultrathink", "be thorough"), pick at least high; if they ask for a quick answer, pick low.

If the message is a short follow-up to ongoing work ("yes", "go", "ok", "continue", or the same in any language), keep the current pair.

Reply with JSON only: {"model":"haiku|sonnet|opus|fable","effort":"low|medium|high|xhigh|max","sure":0.0-1.0 how sure you are of the effort,"why":"at most 6 words, in the user's language"}`

/** Reads `{ model, effort, why }` out of a reply, or nothing when it doesn't hold one. */
export function parseVerdict(text: string): { model: ModelKey; effort: Effort; why: string; sure?: number; handoff?: string } | undefined {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const { model, effort, why, sure, handoff } = raw as Record<string, unknown>
  const key = typeof model === 'string' ? model.toLowerCase() : ''
  const found = MODELS.find(m => key === m.key || key === m.id || key.includes(m.key))
  if (!found || !EFFORTS.includes(effort as Effort)) return undefined
  const how = typeof sure === 'number' && sure >= 0 && sure <= 1 ? { sure } : {}
  // Only a reason counts: "handoff":"" or false is no advice.
  const advice = typeof handoff === 'string' && handoff.trim() ? { handoff: handoff.trim().slice(0, 70) } : {}
  return { model: found.key, effort: effort as Effort, why: typeof why === 'string' ? why.slice(0, 60) : '', ...how, ...advice }
}

/** The context text from the conversation so far: the last user message, short, and the assistant's last reply's end. */
export function contextFrom(messages: readonly { role: string; text: string }[]): string {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const lastAssistant = lastAssistantText(messages)
  return [lastUser ? `user: ${lastUser.text.slice(0, 400)}` : '', lastAssistant ? `assistant: ${lastAssistant.slice(-2000)}` : '']
    .filter(Boolean)
    .join('\n')
}

/** The assistant's last reply, or nothing. */
export function lastAssistantText(messages: readonly { role: string; text: string }[]): string {
  return [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim())?.text ?? ''
}

/** A short follow-up such as "go", "ok", "yes", "continue": two words and a dozen characters at most. */
export function isFollowUp(text: string): boolean {
  const t = text.trim()
  return t.length > 0 && t.length <= 12 && t.split(/\s+/).length <= 2
}

/**
 * Whether the assistant's last reply ended on a question ("Should I archive it?", "A, B or C?"). A short message
 * after one answers it, and the answer can start a small or a big job, so it goes to the judge instead of keeping
 * the effort.
 */
export function endsOnQuestion(context: string): boolean {
  const reply = context.split('\nassistant: ').pop() ?? ''
  return context.includes('assistant: ') && reply.slice(-400).includes('?')
}

/** The message as the judge reads it: images and files it carries are named, since the judge sees only text. */
export function withAttachments(text: string, attachments?: readonly { type: string }[]): string {
  if (!attachments?.length) return text
  const counts = new Map<string, number>()
  for (const a of attachments) counts.set(a.type, (counts.get(a.type) ?? 0) + 1)
  const said = [...counts].map(([type, n]) => `${n} ${type}${n > 1 ? 's' : ''}`).join(', ')
  return `${text}

[The message comes with ${said} to look at.]`
}

/** The message as the judge reads it when it was typed while a task was still running. */
export function withMidTurn(text: string, effort: Effort): string {
  return `${text}

[Sent while the assistant was still working on the last task at ${effort} effort. If it adds to, corrects or steers that task, keep ${effort}; judge it on its own only if it is a separate new request.]`
}

/** A short follow-up that keeps the current effort: "go" between two steps, not an answer to a question. */
export function keepsEffort(message: string, context: string): boolean {
  return isFollowUp(message) && !endsOnQuestion(context)
}

/** Why a judge the person picked could not answer, in words: what a status code means for them. */
export function judgeFailure(name: string, status: number | 'timeout'): string {
  if (status === 'timeout') return `${name} did not answer in time`
  if (status === 401 || status === 403) return `${name} rejected the key (${status})`
  if (status === 402) return `${name} is out of credits (${status})`
  if (status === 429) return `${name} is rate limited (${status})`
  return `${name} failed (${status})`
}

/** The text the judge reads: the current pair, the last turns and the next message. Upstream types `current` as its Pick. */
export function judgeQuestion(prompt: string, current: { model: ModelKey; effort: Effort } | null, context: string): string {
  return [
    current ? `Current: ${current.model} / ${current.effort}` : 'Current: none',
    context ? `Recent conversation:\n${context}` : '',
    `Next message:\n${prompt.slice(0, 2000)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * A message that says the last answer was wrong or did not work. After a prompt ran on a cheaper model, this is the
 * signal the cheaper model missed: the retry and the next few prompts stay on the chat's own model.
 */
const REDO_RE = /^(no|nope|nah)(?![a-z'])(?! +(problem|worries|thanks|thank|need|rush|hurry))|^(that'?s |this is |it'?s )?(wrong|incorrect|not (right|correct|what i))|^(it |that |this )?(still )?(doesn'?t|didn'?t|isn'?t|does not|did not|is not) (work|fix|help|change|run|compile|pass)|^still (not|broken|wrong|failing|fails|the same|happening|doesn'?t)|^(not working|try again|do it again|redo|you missed|you forgot|you broke)|^(fel|inte rätt|funkar inte|fungerar inte|försök igen|gör om|det är fel)(?![a-zåäö])|(still (broken|wrong|failing)|try again|funkar fortfarande inte)/i
export const REDO_STAY_PROMPTS = 4
export function looksLikeRedo(text: string): boolean {
  return REDO_RE.test(text.trim().replace(/^["'“ ]+/, ''))
}

/**
 * The effort slider tips close calls only: a verdict the judge was unsure of moves one step toward cheaper or smarter.
 * The outer stops count more calls as close. A sure verdict, or one without a confidence, stays as it is.
 */
export function tipped(effort: Effort, sure: number | undefined, bias: number): Effort {
  if (!bias || sure === undefined || sure >= (Math.abs(bias) === 1 ? 0.65 : 0.85)) return effort
  const i = Math.max(0, Math.min(EFFORTS.length - 1, EFFORTS.indexOf(effort) + Math.sign(bias)))
  return EFFORTS[i]
}

/** Floor and ceiling from the settings: what Auto picks stays between them. */
export function bounded(effort: Effort, floor: Effort, ceiling: Effort): Effort {
  const lo = EFFORTS.indexOf(floor)
  const hi = Math.max(lo, EFFORTS.indexOf(ceiling))
  return EFFORTS[Math.max(lo, Math.min(hi, EFFORTS.indexOf(effort)))]
}

/** What the judge reads for a subagent: its task, said to be one, so it judges the subagent's work. */
export function helperQuestion(prompt: string, type: string): string {
  return `${prompt.slice(0, 4000)}

[This is the task Claude gave a ${type} subagent, not a message from the person. Judge the effort that subagent needs to do it well.]`
}

/** The lowest effort a helper gets: medium, or the person's Min when higher, never above their Max. A helper's answer
 * goes back to the chat unchecked, and at low it miscounted where medium did not (bench/results/helpers-2026-10-10.md). */
export function helperFloor(floor: Effort, ceiling: Effort): Effort {
  const i = Math.min(Math.max(EFFORTS.indexOf(floor), EFFORTS.indexOf('medium')), EFFORTS.indexOf(ceiling))
  return EFFORTS[i]
}

export type BenchCase = { id: string; kind: string; holdout?: boolean; current: { model: ModelKey; effort: Effort }; context?: string; message: string; ok: Effort[] }

/** Where an answer lands against the labels: right, too low (risks quality), too high (wastes), or no answer. */
export function benchGrade(c: BenchCase, effort: Effort | undefined): 'hit' | 'under' | 'over' | 'none' {
  if (!effort) return 'none'
  if (c.ok.includes(effort)) return 'hit'
  const rank = EFFORTS.indexOf(effort)
  return rank < Math.min(...c.ok.map(e => EFFORTS.indexOf(e))) ? 'under' : 'over'
}

// Upstream's judge call settings (askHaiku): Haiku 5.5 by id, 160 output tokens, low effort, 6 s.
export const JUDGE_CALL = { model: 'claude-haiku-5-5', maxTokens: 160, effort: 'low' as Effort, timeoutMs: 6000 }
