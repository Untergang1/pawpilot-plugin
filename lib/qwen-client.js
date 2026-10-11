export class QwenClientError extends Error {
  constructor (message, code = 'QWEN_REQUEST_FAILED') {
    super(message)
    this.name = 'QwenClientError'
    this.code = code
  }
}

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

export class QwenClient {
  constructor ({
    apiKey,
    baseURL = 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model,
    timeoutMs = 30_000,
    fetchImpl = fetch
  }) {
    this.apiKey = apiKey
    this.baseURL = baseURL.replace(/\/$/, '')
    this.model = model
    this.timeoutMs = timeoutMs
    this.fetch = fetchImpl
  }

  async complete ({ messages, tools, signal }) {
    if (!this.apiKey) throw new QwenClientError('DashScope API key is not configured', 'API_KEY_MISSING')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const abortFromCaller = () => controller.abort()
    signal?.addEventListener?.('abort', abortFromCaller, { once: true })
    let response
    try {
      response = await this.fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools,
          tool_choice: tools.length ? 'auto' : 'none',
          temperature: 0.2
        }),
        signal: controller.signal
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new QwenClientError('DashScope request timed out', 'REQUEST_TIMEOUT')
      }
      throw new QwenClientError('DashScope request could not be sent', 'NETWORK_ERROR')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener?.('abort', abortFromCaller)
    }

    let body
    try {
      body = await response.json()
    } catch {
      throw new QwenClientError(`DashScope returned an invalid response (HTTP ${response.status})`, 'INVALID_RESPONSE')
    }
    if (!response.ok) {
      const code = typeof body?.error?.code === 'string' ? body.error.code : 'HTTP_ERROR'
      throw new QwenClientError(`DashScope request failed (HTTP ${response.status}, ${code})`, code)
    }
    const message = body?.choices?.[0]?.message
    if (!message || typeof message !== 'object') {
      throw new QwenClientError('DashScope response has no assistant message', 'INVALID_RESPONSE')
    }
    const usage = normalizeUsage(body.usage)
    return usage ? { ...message, usage } : message
  }
}
