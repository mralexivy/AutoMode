// Router mode and provider rules. AUTOMODE_ROUTER=off is the kill switch and wins over config.
import type { Mode } from './types.ts'

export function modeOf(config: { mode?: unknown }, env: { AUTOMODE_ROUTER?: string | undefined }): Mode {
  const e = (env.AUTOMODE_ROUTER ?? '').trim().toLowerCase()
  if (e === 'off' || e === '0' || e === 'false') return 'off'
  if (e === 'shadow') return 'shadow'
  if (e === 'auto') return config.mode === 'off' ? 'off' : 'auto'
  return config.mode === 'auto' || config.mode === 'off' ? config.mode : 'shadow'
}

export interface ProviderEnv {
  CLAUDE_CODE_USE_VERTEX?: string; CLAUDE_CODE_USE_BEDROCK?: string; CLAUDE_CODE_USE_FOUNDRY?: string
  ANTHROPIC_BASE_URL?: string; CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS?: string
}

const on = (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false'

export function providerOf(env: ProviderEnv): 'anthropic' | 'vertex' | 'bedrock' | 'foundry' | 'gateway' {
  if (on(env.CLAUDE_CODE_USE_VERTEX)) return 'vertex'
  if (on(env.CLAUDE_CODE_USE_BEDROCK)) return 'bedrock'
  if (on(env.CLAUDE_CODE_USE_FOUNDRY)) return 'foundry'
  if (env.ANTHROPIC_BASE_URL && !/^https:\/\/api\.anthropic\.com\/?$/.test(env.ANTHROPIC_BASE_URL)) return 'gateway'
  return 'anthropic'
}

// effortSharesCache: per the Claude Code prompt-caching docs, an effort change keeps the cache on the
// 5.5 models only with an API key or a Claude subscription, never on Vertex, Bedrock, a gateway, or
// with experimental betas disabled. Foundry hosted on Anthropic may keep it; treated as not, to be safe.
export function effortSharesCache(env: ProviderEnv, model: string): boolean {
  if (providerOf(env) !== 'anthropic') return false
  if (on(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) return false
  return /(opus|sonnet|haiku)-5-5|fable-5-1/.test(model)
}

// thinkingRisk: a thinking configuration under which the API can answer 400 to a per-message effort change. From the
// Anthropic effort docs: Sonnet 5.5 with `between_tools` (and at xhigh or max), Haiku 5.5 with thinking disabled (and at
// xhigh or max), Opus 5.5 with thinking disabled at any level. The mod cannot read the request's thinking block, so this
// reads what Claude Code is configured with: MAX_THINKING_TOKENS=0, a disabled or between_tools thinking setting. It is a
// guard, not a proof: where it says yes, effort is left as the app set it. `AUTOMODE_THINKING_GUARD=off|on` overrides.
export function thinkingRisk(env: { MAX_THINKING_TOKENS?: string; AUTOMODE_THINKING_GUARD?: string }, settings: unknown): boolean {
  const g = (env.AUTOMODE_THINKING_GUARD ?? '').trim().toLowerCase()
  if (g === 'off') return false
  if (g === 'on') return true
  if (String(env.MAX_THINKING_TOKENS ?? '').trim() === '0') return true
  const s = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>
  if (s.alwaysThinkingEnabled === false) return true
  const t = JSON.stringify(s.thinking ?? s.thinkingMode ?? '')
  return /between_tools|disabled/i.test(t)
}

// ttlMs: the main conversation's cache lifetime. One hour on a Claude plan within its usage, five
// minutes with an API key or a cloud provider, unless set explicitly.
export function ttlMs(env: { CLAUDE_CODE_PROMPT_CACHE_TTL?: string; FORCE_PROMPT_CACHING_5M?: string; ENABLE_PROMPT_CACHING_1H?: string }, provider: string, onPlan: boolean): number {
  if (on(env.FORCE_PROMPT_CACHING_5M)) return 300_000
  if (env.CLAUDE_CODE_PROMPT_CACHE_TTL === '1h') return 3_600_000
  if (env.CLAUDE_CODE_PROMPT_CACHE_TTL === '5m') return 300_000
  if (on(env.ENABLE_PROMPT_CACHING_1H)) return 3_600_000
  return provider === 'anthropic' && onPlan ? 3_600_000 : 300_000
}
