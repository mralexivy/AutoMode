// Compaction helpers shared by the V3 and V4 routers: Haiku writes the summary.

export const COMPACT_SYSTEM = `You compact a conversation between a user and Claude Code, an AI coding agent, so the work continues in a fresh context that holds only your summary. Whoever reads it next knows nothing else.
Write these sections:
1. Request and intent: everything the user asked for, including changes of mind.
2. Key decisions and constraints.
3. Files: every file read, created or edited, why it matters, and important snippets or signatures.
4. Errors and fixes, with any user feedback about them.
5. All user messages, briefly, in order.
6. Pending tasks.
7. Current work: exactly what was being done right before this summary, with file names and code; carry over the code and errors from the last messages in full.
Be specific: names, paths, commands and numbers, not descriptions of them.`

// transcriptOf flattens messages for the compaction model: older messages cut short, the last few
// nearly whole, since the next step builds on them.
export function transcriptOf(messages: readonly { role: string; text: string; toolUses?: readonly { tool: string; input: Record<string, unknown> }[]; toolResults?: readonly { text: string; isError: boolean }[] }[], maxChars = 600000): string {
  const keepWhole = 6
  const parts = messages.map((m, i) => {
    const near = i >= messages.length - keepWhole
    const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} [... ${s.length - n} chars]` : s)
    const text = cut(m.text || '', near ? 20000 : 2000)
    const tools = (m.toolUses || []).map((t) => `  [tool ${t.tool}] ${cut(JSON.stringify(t.input), near ? 4000 : 300)}`).join('\n')
    const results = (m.toolResults || []).map((r) => `  [${r.isError ? 'error' : 'result'}] ${cut(r.text || '', near ? 8000 : 400)}`).join('\n')
    return `${m.role.toUpperCase()}: ${text}${tools ? `\n${tools}` : ''}${results ? `\n${results}` : ''}`
  })
  let out = parts.join('\n\n')
  // Still too long: drop the oldest messages first, never the recent ones.
  while (out.length > maxChars && parts.length > keepWhole) { parts.shift(); out = `[earlier messages dropped]\n\n${parts.join('\n\n')}` }
  return out
}
