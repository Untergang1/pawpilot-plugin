import { ChatGPTClient } from './chatgpt-client.js'
import { ModelClientError } from './model-client.js'
import { QwenClient } from './qwen-client.js'

function optionalString (value) {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * Model backends keyed by `provider`. Each factory reads only its own config section
 * (already normalized by lib/config.js) and returns a client implementing the
 * lib/model-client.js contract.
 */
const PROVIDERS = Object.freeze({
  dashscope (section) {
    const apiKey = process.env.DASHSCOPE_API_KEY || section.apiKey
    if (!apiKey) throw new ModelClientError('DashScope API key is not configured', 'API_KEY_MISSING', { provider: 'dashscope' })
    return new QwenClient({
      apiKey,
      baseURL: optionalString(section.baseURL),
      model: section.model,
      temperature: section.temperature,
      timeoutMs: section.requestTimeoutMs,
      vision: section.vision === true,
      webSearch: section.webSearch,
      searchStrategy: section.searchStrategy
    })
  },
  chatgpt (section) {
    return new ChatGPTClient({
      credentialsFile: optionalString(section.credentialsFile),
      model: optionalString(section.model),
      reasoningEffort: optionalString(section.reasoningEffort),
      timeoutMs: section.requestTimeoutMs,
      webSearch: section.webSearch,
      webSearchMaxSources: section.webSearchMaxSources
    })
  }
})

export function createModelClient (config) {
  const factory = Object.hasOwn(PROVIDERS, config.provider) ? PROVIDERS[config.provider] : null
  if (!factory) throw new ModelClientError(`Unknown model provider: ${config.provider}`, 'INVALID_PROVIDER')
  return factory(config[config.provider] ?? {})
}
