// Gemini generateContent. A model turn goes back as its raw parts, because thought signatures must return unchanged.
// Each functionResponse repeats the id and name of its functionCall.
import { needKey, parseArgs, postJson, type CanonicalCompletion, type CanonicalMessage, type CompletionRequest, type ProviderAdapter, type ToolCall } from './provider.mts'

function contents(messages: CanonicalMessage[]) {
  const out: { role: string; parts: unknown[] }[] = []
  const push = (role: string, parts: unknown[]) => {
    const last = out[out.length - 1]
    if (last?.role === role) last.parts.push(...parts)
    else out.push({ role, parts })
  }
  for (const m of messages) {
    if (m.role === 'user') push('user', [{ text: m.text }])
    else if (m.role === 'tool') push('user', [{ functionResponse: { id: m.callId, name: m.name, response: { result: m.text } } }])
    else push('model', Array.isArray(m.native) ? m.native : [...(m.text ? [{ text: m.text }] : []), ...m.toolCalls.map((c) => ({ functionCall: { id: c.id, name: c.name, args: c.args } }))])
  }
  return out
}

export function requestBody(req: CompletionRequest) {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: contents(req.messages),
    tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }],
    generationConfig: {
      ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
      ...(req.reasoning?.effort ? { thinkingConfig: { thinkingLevel: req.reasoning.effort } } : {}),
    },
    ...(req.reasoning?.native ?? {}),
  }
}

export function fromResponse(j: any): CanonicalCompletion {
  const candidate = j.candidates?.[0] ?? {}
  const parts: any[] = candidate.content?.parts ?? []
  const toolCalls: ToolCall[] = parts.filter((p) => p.functionCall).map((p, i) => ({ id: p.functionCall.id ?? `call-${i}`, name: p.functionCall.name, args: parseArgs(p.functionCall.args) }))
  const u = j.usageMetadata ?? {}
  const reason = candidate.finishReason
  const output = u.candidatesTokenCount === undefined && u.thoughtsTokenCount === undefined ? null : (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)
  return {
    text: parts.filter((p) => p.text && !p.thought).map((p) => p.text).join(''), toolCalls, native: parts, effectiveModel: j.modelVersion ?? null, nativeUsage: u,
    stop: toolCalls.length ? 'tool' : reason === 'MAX_TOKENS' ? 'length' : reason === 'SAFETY' || reason === 'RECITATION' || j.promptFeedback?.blockReason ? 'refused' : reason === 'STOP' ? 'end' : 'other',
    usage: { inputTokens: u.promptTokenCount ?? null, outputTokens: output, reasoningTokens: u.thoughtsTokenCount ?? null, cacheReadTokens: u.cachedContentTokenCount ?? null, cacheWriteTokens: null },
  }
}

export const geminiAdapter = (fetchImpl?: typeof fetch): ProviderAdapter => ({
  id: 'google',
  complete: async (req, model, signal) => fromResponse(await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': needKey('GEMINI_API_KEY') }, requestBody(req), signal, fetchImpl)),
})
