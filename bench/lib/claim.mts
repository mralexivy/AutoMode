// The agent's explicit completion claim. Prompt template repo-change-v2 asks the final message to end with one line,
// `Status: done` or `Status: not done`. Only the parsed boolean reaches a result row, never the reply text.

// claimOf reads the last status line. It gives null when the message has none, so a missing line stays ambiguous.
export function claimOf(text: string | null | undefined): boolean | null {
  if (typeof text !== 'string') return null
  const lines = [...text.matchAll(/^[\s*_`>-]*status:[\s*_`]*(done|not done)[\s*_`.]*$/gim)]
  if (!lines.length) return null
  return lines[lines.length - 1][1].toLowerCase() === 'done'
}

// asksForClaim: the template's text names the status line, so its runs can claim explicitly.
export const asksForClaim = (templateText: string) => /Status: done/.test(templateText) && /Status: not done/.test(templateText)

export interface CompletionField { claim_asked: boolean; claimed?: boolean; gate_state?: string; gate_blocked?: boolean }

// completionField: what a result row records about completion. `claimed` is set only when the template asked and the
// agent answered. The gate fields come from the plugin's last completion record, for an AutoMode arm.
export function completionField(templateText: string, finalStatus: boolean | null | undefined, gate: { state: string; blocked: boolean } | null): CompletionField | undefined {
  const asked = asksForClaim(templateText)
  if (!asked && !gate) return undefined
  return { claim_asked: asked, ...(asked && typeof finalStatus === 'boolean' ? { claimed: finalStatus } : {}), ...(gate ? { gate_state: gate.state, gate_blocked: gate.blocked } : {}) }
}
