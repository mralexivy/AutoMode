// One interface for every model API, so the neutral agent loop never sees a vendor's format. Adapters translate; they
// hold no repository logic. Each keeps the provider's raw usage, so a change in its accounting can be reconstructed.
export interface CanonicalTool { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }

export type CanonicalMessage =
  | { role: 'user'; text: string }
  // `native` is the provider's own form of this turn. Some APIs need it back unchanged, such as Gemini's thought signatures.
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; native?: unknown }
  | { role: 'tool'; callId: string; name: string; text: string }

export interface CanonicalReasoning { effort?: string; native?: Record<string, unknown> }

export interface CompletionRequest {
  system: string
  messages: CanonicalMessage[]
  tools: CanonicalTool[]
  maxOutputTokens?: number
  reasoning?: CanonicalReasoning
}

export interface NormalizedUsage {
  inputTokens: number | null // every prompt token, cached or not
  outputTokens: number | null // every generated token, reasoning included
  reasoningTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
}

export interface CanonicalCompletion {
  text: string
  toolCalls: ToolCall[]
  stop: 'end' | 'tool' | 'length' | 'refused' | 'other'
  usage: NormalizedUsage
  nativeUsage: unknown
  effectiveModel: string | null
  native?: unknown
}

export interface ProviderAdapter {
  readonly id: string
  complete(req: CompletionRequest, model: string, signal?: AbortSignal): Promise<CanonicalCompletion>
}

export type ErrorKind = 'rate_limit' | 'auth' | 'server' | 'bad_request' | 'network'

export class ProviderError extends Error {
  kind: ErrorKind
  status: number | null
  constructor(kind: ErrorKind, status: number | null, message: string) {
    super(message)
    this.kind = kind
    this.status = status
  }
}

export const errorKind = (status: number): ErrorKind =>
  status === 429 ? 'rate_limit' : status === 401 || status === 403 ? 'auth' : status >= 500 ? 'server' : 'bad_request'

// postJson is the one network call. Tests pass their own `fetchImpl`. An error message holds the status and the
// provider's error text only: never a key, and never the request.
export async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal | undefined, fetchImpl: typeof fetch = fetch) {
  let res: Response
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal })
  } catch (e) {
    throw new ProviderError('network', null, `request failed: ${(e as Error).name}`)
  }
  const text = await res.text()
  if (!res.ok) throw new ProviderError(errorKind(res.status), res.status, `HTTP ${res.status}: ${text.slice(0, 300)}`)
  try { return JSON.parse(text) } catch { throw new ProviderError('server', res.status, 'the reply was not JSON') }
}

export function needKey(name: string, env: NodeJS.ProcessEnv = process.env) {
  const key = env[name]
  if (!key) throw new ProviderError('auth', null, `${name} is not set`)
  return key
}

// parseArgs reads tool arguments from a model. Bad JSON becomes a marker the loop reports back, so the model can retry.
export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  try { const v = JSON.parse(String(raw)); return v && typeof v === 'object' ? v : { _bad_arguments: String(raw).slice(0, 200) } } catch { return { _bad_arguments: String(raw).slice(0, 200) } }
}
