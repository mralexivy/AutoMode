// Anthropic Messages API, for the neutral track only. It needs an API key: a Max plan covers `claude -p`, not this API.
import { needKey, parseArgs, postJson, type CanonicalCompletion, type CanonicalMessage, type CompletionRequest, type ProviderAdapter, type ToolCall } from './provider.mts'

function messages(list: CanonicalMessage[]) {
  const out: { role: string; content: unknown[] }[] = []
  const push = (role: string, content: unknown[]) => {
    const last = out[out.length - 1]
    if (last?.role === role) last.content.push(...content)
    else out.push({ role, content })
  }
  for (const m of list) {
    if (m.role === 'user') push('user', [{ type: 'text', text: m.text }])
    else if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.callId, content: m.text }])
    else push('assistant', Array.isArray(m.native) ? m.native : [...(m.text ? [{ type: 'text', text: m.text }] : []), ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))])
  }
  return out
}

export function requestBody(req: CompletionRequest, model: string) {
  return {
    model, system: req.system, messages: messages(req.messages), max_tokens: req.maxOutputTokens ?? 16000,
    tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    ...(req.reasoning?.effort ? { output_config: { effort: req.reasoning.effort } } : {}),
    ...(req.reasoning?.native ?? {}),
  }
}

export function fromResponse(j: any): CanonicalCompletion {
  const blocks: any[] = j.content ?? []
  const toolCalls: ToolCall[] = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: parseArgs(b.input) }))
  const u = j.usage ?? {}
  const prompt = u.input_tokens === undefined ? null : u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''), toolCalls, native: blocks, effectiveModel: j.model ?? null, nativeUsage: u,
    stop: j.stop_reason === 'tool_use' ? 'tool' : j.stop_reason === 'max_tokens' ? 'length' : j.stop_reason === 'refusal' ? 'refused' : j.stop_reason === 'end_turn' ? 'end' : 'other',
    usage: { inputTokens: prompt, outputTokens: u.output_tokens ?? null, reasoningTokens: u.output_tokens_details?.thinking_tokens ?? null, cacheReadTokens: u.cache_read_input_tokens ?? null, cacheWriteTokens: u.cache_creation_input_tokens ?? null },
  }
}

export const anthropicAdapter = (fetchImpl?: typeof fetch): ProviderAdapter => ({
  id: 'anthropic',
  complete: async (req, model, signal) => fromResponse(await postJson('https://api.anthropic.com/v1/messages', { 'x-api-key': needKey('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' }, requestBody(req, model), signal, fetchImpl)),
})
