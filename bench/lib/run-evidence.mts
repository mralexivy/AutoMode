// What a run really did, read from its transcripts: the models and efforts sent, requests per model, compactions.
// A requested arm is a plan. These fields are what happened. The CLI's JSON reply has no effort or fallback field.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseLines, requestsOf } from './transcripts.mts'

export const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

// sessionFiles returns the session's main transcript and every subagent transcript, or null if it has none.
export function sessionFiles(sessionId: string | null | undefined): { project: string; files: string[] } | null {
  if (!sessionId) return null
  const root = path.join(configDir(), 'projects')
  if (!fs.existsSync(root)) return null
  for (const project of fs.readdirSync(root)) {
    const main = path.join(root, project, `${sessionId}.jsonl`)
    if (!fs.existsSync(main)) continue
    const files = [main]
    const scan = (p: string) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, e.name)
        if (e.isDirectory()) scan(q)
        else if (q.endsWith('.jsonl')) files.push(q)
      }
    }
    const dir = path.join(root, project, sessionId)
    if (fs.existsSync(dir)) scan(dir)
    return { project, files }
  }
  return null
}

export interface RunEvidence {
  effective_models: string[]
  effective_efforts: string[]
  requests: Record<string, number>
  compactions: number
  peak_prompt_tokens: number | null
  tokens: { input: number; output: number; thinking: number | null; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }
  by_model: Record<string, { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }>
}

export function runEvidence(sessionId: string | null | undefined): RunEvidence | null {
  const found = sessionFiles(sessionId)
  if (!found) return null
  const models = new Set<string>(), efforts = new Set<string>(), requests: Record<string, number> = {}, by_model: RunEvidence['by_model'] = {}
  const tokens = { input: 0, output: 0, thinking: null as number | null, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
  let compactions = 0, peak: number | null = null
  for (const file of found.files) {
    const lines: any[] = parseLines(file)
    compactions += lines.filter((r) => r.type === 'system' && r.subtype === 'compact_boundary').length
    const seen: Map<string, any> = requestsOf(lines)
    for (const q of seen.values()) {
      if (!q.model || q.model === '<synthetic>') continue
      models.add(q.model)
      if (q.appEffort) efforts.add(q.appEffort)
      requests[q.model] = (requests[q.model] ?? 0) + 1
      const t = q.tokens
      const m = (by_model[q.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const) { m[k] += t[k]; tokens[k] += t[k] }
      if (t.thinking !== null) tokens.thinking = (tokens.thinking ?? 0) + t.thinking
      peak = Math.max(peak ?? 0, t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h)
    }
  }
  return { effective_models: [...models].sort(), effective_efforts: [...efforts].sort(), requests, compactions, peak_prompt_tokens: peak, tokens, by_model }
}
