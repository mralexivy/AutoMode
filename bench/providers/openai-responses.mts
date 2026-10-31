// OpenAI Responses API. Assistant turns go back as the output items they came from.
import { needKey, parseArgs, postJson, type CanonicalCompletion, type CanonicalMessage, type CompletionRequest, type ProviderAdapter, type ToolCall } from './provider.mts'

function input(messages: CanonicalMessage[]) {
  return messages.flatMap((m): unknown[] => {
    if (m.role === 'user') return [{ role: 'user', content: m.text }]
    if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.callId, output: m.text }]
    if (Array.isArray(m.native)) return m.native
    return [
      ...(m.text ? [{ role: 'assistant', content: m.text }] : []),
      ...m.toolCalls.map((c) => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) })),
    ]
  })
}

export function requestBody(req: CompletionRequest, model: string) {
  return {
    model, instructions: req.system, input: input(req.messages), store: false,
    tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
    ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
    ...(req.reasoning?.effort ? { reasoning: { effort: req.reasoning.effort } } : {}),
    ...(req.reasoning?.native ?? {}),
  }
}

export function fromResponse(j: any): CanonicalCompletion {
  const output: any[] = j.output ?? []
  const toolCalls: ToolCall[] = output.filter((o) => o.type === 'function_call').map((o) => ({ id: o.call_id, name: o.name, args: parseArgs(o.arguments) }))
  const text = output.filter((o) => o.type === 'message').flatMap((o) => o.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('')
  const refused = output.some((o) => o.type === 'message' && (o.content ?? []).some((c: any) => c.type === 'refusal'))
  const u = j.usage ?? {}
  return {
    text, toolCalls, native: output, effectiveModel: j.model ?? null, nativeUsage: u,
    stop: refused ? 'refused' : toolCalls.length ? 'tool' : j.status === 'incomplete' ? 'length' : 'end',
    usage: { inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null, reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? null, cacheReadTokens: u.input_tokens_details?.cached_tokens ?? null, cacheWriteTokens: u.input_tokens_details?.cache_write_tokens ?? null },
  }
}

export const openaiAdapter = (fetchImpl?: typeof fetch): ProviderAdapter => ({
  id: 'openai',
  complete: async (req, model, signal) => fromResponse(await postJson('https://api.openai.com/v1/responses', { authorization: `Bearer ${needKey('OPENAI_API_KEY')}` }, requestBody(req, model), signal, fetchImpl)),
})
