/**
 * Shared contract for model clients. Every client exposes
 * `complete({ messages, tools, cacheKey, reasoningEffort, signal })`, where
 * `cacheKey` and the per-call `reasoningEffort` override are hints a client may
 * ignore. It takes chat-completions style messages, returns an OpenAI-style
 * assistant message with optional provider-neutral `usage`, and throws
 * ModelClientError with one of the common codes below.
 *
 * Common codes: API_KEY_MISSING, MODEL_MISSING, INVALID_PROVIDER, AUTH_FAILED,
 * RATE_LIMITED, USAGE_LIMIT, REQUEST_TIMEOUT, NETWORK_ERROR, SERVER_ERROR,
 * HTTP_ERROR, INVALID_RESPONSE. Clients may add provider-specific codes; the raw
 * code reported by the provider is kept in `providerCode`.
 *
 * Clients also expose `supportsImages`. When it is true, the current user message
 * may carry chat-completions content parts instead of a string:
 * `[{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/...' } }]`.
 * All other messages keep string content.
 */
export class ModelClientError extends Error {
  constructor (message, code = 'MODEL_REQUEST_FAILED', { provider, providerCode } = {}) {
    super(message)
    this.name = 'ModelClientError'
    this.code = code
    this.provider = provider
    this.providerCode = providerCode
  }
}

export function httpErrorCode (status) {
  if (status === 401 || status === 403) return 'AUTH_FAILED'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'SERVER_ERROR'
  return 'HTTP_ERROR'
}

/**
 * Runs `run(signal)` under one timeout shared by every attempt, following the
 * caller's abort signal. Timeouts and transport failures become ModelClientError;
 * ModelClientError instances thrown by `run` pass through unchanged.
 */
export async function withRequestTimeout ({ provider, timeoutMs, signal }, run) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const abortFromCaller = () => controller.abort()
  signal?.addEventListener?.('abort', abortFromCaller, { once: true })
  try {
    return await run(controller.signal)
  } catch (error) {
    if (controller.signal.aborted) throw new ModelClientError(`${provider} request timed out`, 'REQUEST_TIMEOUT', { provider })
    if (error instanceof ModelClientError) throw error
    throw new ModelClientError(`${provider} request could not be completed`, 'NETWORK_ERROR', { provider })
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener?.('abort', abortFromCaller)
  }
}

/**
 * Sends once more when the first response is an HTTP 5xx, which is usually transient.
 * Pass `response` when the first attempt has already been made.
 */
export async function retryOnServerError (send, response) {
  response ??= await send()
  if (response.status < 500) return response
  await response.body?.cancel?.()
  return send()
}
