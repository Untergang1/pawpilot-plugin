import { ModelClientError, httpErrorCode, retryOnServerError, withRequestTimeout } from './model-client.js'

const PROVIDER = 'dashscope'

/** Maps chat/completions usage to the provider-neutral usage shape. */
export function normalizeUsage (usage) {
  if (!usage || typeof usage !== 'object') return undefined
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0
  }
}

/** Model client for OpenAI-compatible chat/completions endpoints such as DashScope. */
export class QwenClient {
  constructor ({
    apiKey,
    baseURL = 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model,
    temperature = 0.7,
    timeoutMs = 30_000,
    fetchImpl = fetch
  }) {
    this.apiKey = apiKey
    this.baseURL = baseURL.replace(/\/$/, '')
    this.model = model
    this.temperature = temperature
    this.timeoutMs = timeoutMs
    this.fetch = fetchImpl
  }

  async complete ({ messages, tools, signal }) {
    if (!this.apiKey) throw new ModelClientError('DashScope API key is not configured', 'API_KEY_MISSING', { provider: PROVIDER })
    const body = JSON.stringify({
      model: this.model,
      messages,
      tools,
      tool_choice: tools.length ? 'auto' : 'none',
      temperature: this.temperature
    })
    return withRequestTimeout({ provider: PROVIDER, timeoutMs: this.timeoutMs, signal }, async abortSignal => {
      const response = await retryOnServerError(() => this.fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body,
        signal: abortSignal
      }))
      let result
      try {
        result = await response.json()
      } catch {
        throw new ModelClientError(`DashScope returned an invalid response (HTTP ${response.status})`, 'INVALID_RESPONSE', { provider: PROVIDER })
      }
      if (!response.ok) {
        const providerCode = typeof result?.error?.code === 'string' ? result.error.code : undefined
        throw new ModelClientError(`DashScope request failed (HTTP ${response.status}, ${providerCode ?? 'unknown'})`,
          httpErrorCode(response.status), { provider: PROVIDER, providerCode })
      }
      const message = result?.choices?.[0]?.message
      if (!message || typeof message !== 'object') {
        throw new ModelClientError('DashScope response has no assistant message', 'INVALID_RESPONSE', { provider: PROVIDER })
      }
      const usage = normalizeUsage(result.usage)
      return usage ? { ...message, usage } : message
    })
  }
}
