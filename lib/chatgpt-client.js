import { API_RESOURCE, ChatGPTCredentials } from './chatgpt-auth.js'
import { ModelClientError, httpErrorCode, retryOnServerError, withRequestTimeout } from './model-client.js'

const PROVIDER = 'chatgpt'

// Plan-usage requests must not be stored and must stream; sampling and output-limit
// fields such as temperature or max_output_tokens are rejected on this route.
const USAGE_LIMIT_CODES = new Set([
  'subscription_sharing_usage_limit_exceeded',
  'subscription_sharing_usage_unavailable'
])

function streamError (message, providerCode, fallback) {
  const code = USAGE_LIMIT_CODES.has(providerCode) ? 'USAGE_LIMIT' : fallback
  return new ModelClientError(message, code, { provider: PROVIDER, providerCode })
}

function toInputContent (part) {
  if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url }
  return { type: 'input_text', text: part.text }
}

function toInputItems (message) {
  if (message.role === 'tool') {
    return [{ type: 'function_call_output', call_id: message.tool_call_id, output: String(message.content ?? '') }]
  }
  if (message.role === 'assistant') {
    // With store: false the server keeps no reasoning state, so the encrypted reasoning
    // from earlier tool rounds is replayed before the calls it produced.
    const items = (message.reasoning_items ?? []).map(item => ({
      type: 'reasoning',
      summary: item.summary ?? [],
      encrypted_content: item.encrypted_content
    }))
    if (message.content) items.push({ role: 'assistant', content: message.content })
    for (const call of message.tool_calls ?? []) {
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments ?? '{}'
      })
    }
    return items
  }
  // Responses input messages have no `name`; group messages already carry the sender
  // in their text label, so the protocol name is dropped.
  if (Array.isArray(message.content)) {
    return [{ role: 'user', content: message.content.map(toInputContent) }]
  }
  return [{ role: 'user', content: String(message.content ?? '') }]
}

/** Converts chat-completions messages and tools into a Responses API request body. */
export function buildResponsesRequest ({ messages, tools = [], model, reasoningEffort, cacheKey }) {
  const instructions = messages
    .filter(message => message.role === 'system' && typeof message.content === 'string')
    .map(message => message.content)
    .join('\n\n')
  const body = {
    model,
    instructions,
    input: messages.filter(message => message.role !== 'system').flatMap(toInputItems),
    store: false,
    stream: true
  }
  if (tools.length) {
    body.tools = tools.map(tool => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: false
    }))
  }
  if (reasoningEffort) {
    body.reasoning = { effort: reasoningEffort }
    body.include = ['reasoning.encrypted_content']
  }
  if (cacheKey) body.prompt_cache_key = cacheKey
  return body
}

/** Maps Responses usage to the provider-neutral usage shape. */
export function normalizeUsage (usage) {
  if (!usage || typeof usage !== 'object') return undefined
  return {
    inputTokens: usage.input_tokens ?? 0,
    cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0
  }
}

/** Converts completed Responses output items into an OpenAI-style assistant message. */
export function toAssistantMessage (items, usage) {
  const message = toAssistantContent(items)
  const normalized = normalizeUsage(usage)
  if (normalized) message.usage = normalized
  return message
}

function toAssistantContent (items) {
  const text = items
    .filter(item => item.type === 'message')
    .flatMap(item => item.content ?? [])
    .filter(part => part.type === 'output_text')
    .map(part => part.text)
    .join('')
  const calls = items.filter(item => item.type === 'function_call')
  if (!calls.length) return { content: text }
  const reasoning = items.filter(item => item.type === 'reasoning' && typeof item.encrypted_content === 'string')
  return {
    content: text || null,
    ...(reasoning.length ? { reasoning_items: reasoning.map(({ summary, encrypted_content: encrypted }) => ({ summary, encrypted_content: encrypted })) } : {}),
    tool_calls: calls.map(call => ({
      id: call.call_id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments }
    }))
  }
}

/**
 * Reads the server-sent event stream. Output items arrive as `response.output_item.done`
 * events; the final `response.completed` event does not repeat them.
 */
export async function readResponseStream (body) {
  const items = []
  const decoder = new TextDecoder()
  let buffer = ''
  let completed = false
  let usage
  const handle = block => {
    const data = block.split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') return
    let event
    try {
      event = JSON.parse(data)
    } catch {
      throw new ModelClientError('ChatGPT stream contains invalid JSON', 'INVALID_RESPONSE', { provider: PROVIDER })
    }
    if (event.type === 'response.output_item.done' && event.item) items.push(event.item)
    else if (event.type === 'response.completed') {
      completed = true
      usage = event.response?.usage
    }
    else if (event.type === 'response.failed' || event.type === 'error') {
      const code = event.response?.error?.code ?? event.error?.code ?? event.code
      throw streamError(`ChatGPT response failed (${code ?? 'unknown'})`, code, 'RESPONSE_FAILED')
    } else if (event.type === 'response.incomplete') {
      const reason = event.response?.incomplete_details?.reason
      throw new ModelClientError(`ChatGPT response is incomplete (${reason ?? 'unknown'})`, 'RESPONSE_INCOMPLETE', { provider: PROVIDER })
    }
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/gu, '\n')
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      handle(buffer.slice(0, index))
      buffer = buffer.slice(index + 2)
    }
  }
  if (buffer.trim()) handle(buffer)
  if (!completed) throw new ModelClientError('ChatGPT stream ended before completion', 'STREAM_INTERRUPTED', { provider: PROVIDER })
  return { items, usage }
}

/**
 * Model client for the public Responses API using the ChatGPT plan of the account
 * signed in through Sign in with ChatGPT.
 */
export class ChatGPTClient {
  constructor ({
    credentialsFile,
    model,
    reasoningEffort = 'low',
    timeoutMs = 60_000,
    fetchImpl = fetch,
    credentials = new ChatGPTCredentials({ file: credentialsFile, fetchImpl })
  } = {}) {
    this.supportsImages = true
    this.model = model
    this.reasoningEffort = reasoningEffort
    this.timeoutMs = timeoutMs
    this.fetch = fetchImpl
    this.credentials = credentials
  }

  async complete ({ messages, tools = [], cacheKey, reasoningEffort = this.reasoningEffort, signal }) {
    if (!this.model) throw new ModelClientError('ChatGPT model is not configured', 'MODEL_MISSING', { provider: PROVIDER })
    const body = JSON.stringify(buildResponsesRequest({
      messages, tools, model: this.model, reasoningEffort, cacheKey
    }))
    return withRequestTimeout({ provider: PROVIDER, timeoutMs: this.timeoutMs, signal }, async abortSignal => {
      const send = async ({ forceRefresh = false } = {}) =>
        this.#post(body, await this.credentials.accessToken({ forceRefresh }), abortSignal)
      let response = await send()
      if (response.status === 401) {
        // The token may have been revoked or rotated elsewhere; refresh once and retry.
        await response.body?.cancel?.()
        response = await send({ forceRefresh: true })
      }
      response = await retryOnServerError(send, response)
      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        const providerCode = error?.error?.code ?? error?.code
        throw streamError(`ChatGPT request failed (HTTP ${response.status}, ${providerCode ?? 'unknown'})`,
          providerCode, httpErrorCode(response.status))
      }
      const { items, usage } = await readResponseStream(response.body)
      return toAssistantMessage(items, usage)
    })
  }

  #post (body, accessToken, signal) {
    return this.fetch(`${API_RESOURCE}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body,
      signal
    })
  }
}
