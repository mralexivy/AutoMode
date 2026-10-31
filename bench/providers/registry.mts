// Maps a provider id to its adapter.
import { anthropicAdapter } from './anthropic.mts'
import { chatAdapter, DEEPSEEK, localProvider, MISTRAL, XAI } from './chat-completions.mts'
import { geminiAdapter } from './gemini.mts'
import { openaiAdapter } from './openai-responses.mts'
import type { ProviderAdapter } from './provider.mts'

export function adapterFor(provider: string, fetchImpl?: typeof fetch): ProviderAdapter {
  switch (provider) {
    case 'anthropic': return anthropicAdapter(fetchImpl)
    case 'openai': return openaiAdapter(fetchImpl)
    case 'google': return geminiAdapter(fetchImpl)
    case 'deepseek': return chatAdapter(DEEPSEEK, fetchImpl)
    case 'xai': return chatAdapter(XAI, fetchImpl)
    case 'mistral': return chatAdapter(MISTRAL, fetchImpl)
    case 'local': return chatAdapter(localProvider(), fetchImpl)
    default: throw new Error(`no adapter for provider ${provider}`)
  }
}
