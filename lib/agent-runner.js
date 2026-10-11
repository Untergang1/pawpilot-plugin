import fs from 'node:fs'
import { MESSAGES } from './messages.js'
import { isPlainObject } from './util.js'
import {
  CapabilityError,
  MAX_BASE_SYSTEM_PROMPT_CHARS,
  MAX_TOTAL_SYSTEM_PROMPT_CHARS
} from './ai-capabilities.js'

const MAX_TOOL_ARGUMENT_BYTES = 12 * 1024
const MAX_TOOL_RESULT_BYTES = 16 * 1024
const baseSystemPromptFile = new URL('../prompts/SYSTEM_PROMPT.md', import.meta.url)
const conversationSystemPromptFiles = Object.freeze({
  private: new URL('../prompts/PRIVATE_SYSTEM_PROMPT.md', import.meta.url),
  group: new URL('../prompts/GROUP_SYSTEM_PROMPT.md', import.meta.url)
})

function validateBaseSystemPrompt (content) {
  if (typeof content !== 'string' || !content.trim() || content.trim().length > MAX_BASE_SYSTEM_PROMPT_CHARS) {
    throw new CapabilityError('Base system prompt is invalid or too long', 'INVALID_BASE_SYSTEM_PROMPT')
  }
  return content.trim()
}

function validateSystemPromptPart (content, code) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new CapabilityError('System prompt part is invalid', code)
  }
  return content.trim()
}

function readSystemPromptFile (file, code) {
  let content
  try {
    content = fs.readFileSync(file, 'utf8').trim()
  } catch {
    throw new CapabilityError('Unable to read system prompt file', code)
  }
  return content
}

function validateConversationType (conversationType) {
  if (!Object.hasOwn(conversationSystemPromptFiles, conversationType)) {
    throw new CapabilityError('Conversation type must be private or group', 'INVALID_CONVERSATION_TYPE')
  }
  return conversationType
}

export function parseToolArguments (rawArguments) {
  if (typeof rawArguments !== 'string' || Buffer.byteLength(rawArguments, 'utf8') > MAX_TOOL_ARGUMENT_BYTES) {
    throw new CapabilityError('Tool arguments are invalid', 'INVALID_ARGUMENTS')
  }
  try {
    const parsed = JSON.parse(rawArguments)
    if (!isPlainObject(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new CapabilityError('Tool arguments are not valid JSON object', 'INVALID_ARGUMENTS')
  }
}

function toSafeToolContent (result) {
  let json
  try {
    json = JSON.stringify(result ?? { ok: true })
  } catch {
    return JSON.stringify({ ok: false, code: 'INVALID_TOOL_RESULT', message: 'Tool returned an unsupported result.' })
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_TOOL_RESULT_BYTES) {
    return JSON.stringify({ ok: false, code: 'TOOL_RESULT_TOO_LARGE', message: 'Tool result was too large to summarize.' })
  }
  return json
}

function toolErrorContent (error) {
  const code = error instanceof CapabilityError ? error.code : 'TOOL_FAILED'
  return JSON.stringify({ ok: false, code, message: 'The requested capability could not complete. Explain a safe next step.' })
}

function safeConversationMessage (message) {
  if ((message?.role !== 'user' && message?.role !== 'assistant') ||
      typeof message.content !== 'string' || !message.content.trim()) return null
  const safe = { role: message.role, content: message.content.trim() }
  if (typeof message.name === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(message.name)) safe.name = message.name
  return safe
}

function safeContentPart (part) {
  if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text }
  const url = part?.type === 'image_url' ? part.image_url?.url : undefined
  if (typeof url === 'string' && url.startsWith('data:image/')) return { type: 'image_url', image_url: { url } }
  return null
}

/**
 * The current user message may carry chat-completions content parts with inline
 * images; history messages stay plain text.
 */
function safeCurrentMessage (message) {
  if (!Array.isArray(message?.content)) return safeConversationMessage(message)
  if (message.role !== 'user') return null
  const parts = message.content.map(safeContentPart)
  if (parts.some(part => !part) || !parts.some(part => part.type === 'text' && part.text.trim())) return null
  const safe = { role: 'user', content: parts }
  if (typeof message.name === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(message.name)) safe.name = message.name
  return safe
}

export function buildSystemPrompt ({
  conversationType,
  modulePrompts = [],
  baseSystemPrompt,
  conversationSystemPrompt
} = {}) {
  conversationType = validateConversationType(conversationType)
  // Read the editable common and conversation prompts when a request is assembled,
  // so prompt edits take effect without restarting Yunzai or reloading capabilities.
  baseSystemPrompt = baseSystemPrompt ?? readSystemPromptFile(
    baseSystemPromptFile,
    'BASE_SYSTEM_PROMPT_FILE_NOT_FOUND'
  )
  conversationSystemPrompt = conversationSystemPrompt ?? readSystemPromptFile(
    conversationSystemPromptFiles[conversationType],
    'CONVERSATION_SYSTEM_PROMPT_FILE_NOT_FOUND'
  )
  baseSystemPrompt = validateSystemPromptPart(baseSystemPrompt, 'INVALID_BASE_SYSTEM_PROMPT')
  conversationSystemPrompt = validateSystemPromptPart(
    conversationSystemPrompt,
    'INVALID_CONVERSATION_SYSTEM_PROMPT'
  )
  const coreSystemPrompt = validateBaseSystemPrompt([
    baseSystemPrompt,
    `Conversation mode (${conversationType}):\n${conversationSystemPrompt}`
  ].join('\n\n'))
  const guides = modulePrompts
    .slice()
    .sort((left, right) => left.plugin.localeCompare(right.plugin))
    .map(prompt => `Plugin guide (${prompt.plugin}):\n${prompt.content}`)
    .join('\n\n')
  const systemPrompt = [
    coreSystemPrompt,
    guides ? `Registered plugin guides:\n${guides}` : 'Registered plugin guides: none.'
  ].join('\n\n')
  if (systemPrompt.length > MAX_TOTAL_SYSTEM_PROMPT_CHARS) {
    throw new CapabilityError('Complete system prompt is too long', 'SYSTEM_PROMPT_BUDGET_EXCEEDED')
  }
  return systemPrompt
}

/**
 * Runs an OpenAI-compatible function-calling loop without retaining message history.
 */
export async function runFunctionCalling ({
  client,
  registry,
  conversationType,
  event,
  userId,
  groupId,
  isOwner,
  userMessage,
  currentMessage,
  contextMessages = [],
  requestId,
  cacheKey,
  maxToolRounds = 4,
  audit = () => {}
}) {
  const tools = registry.toModelTools({ isOwner })
  const modulePrompts = registry.getSystemPrompts()
  const history = Array.isArray(contextMessages)
    ? contextMessages.map(safeConversationMessage).filter(Boolean)
    : []
  const current = safeCurrentMessage(currentMessage ?? { role: 'user', content: userMessage })
  if (!current || current.role !== 'user') {
    throw new CapabilityError('Current user message is invalid', 'INVALID_CURRENT_MESSAGE')
  }
  const messages = [
    { role: 'system', content: buildSystemPrompt({ conversationType, modulePrompts }) },
    ...history,
    current
  ]
  const context = { event, userId, groupId, isOwner, session: { requestId } }
  const usage = { modelCalls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  const finish = result => ({ ...result, usage })

  for (let round = 0; round <= maxToolRounds; round += 1) {
    const assistant = await client.complete({ messages, tools, cacheKey })
    usage.modelCalls += 1
    for (const key of ['inputTokens', 'cachedTokens', 'outputTokens', 'reasoningTokens']) {
      usage[key] += Number(assistant.usage?.[key]) || 0
    }
    messages.push({
      role: 'assistant',
      content: typeof assistant.content === 'string' ? assistant.content : null,
      tool_calls: Array.isArray(assistant.tool_calls) ? assistant.tool_calls : undefined,
      reasoning_items: Array.isArray(assistant.reasoning_items) ? assistant.reasoning_items : undefined
    })
    const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : []
    if (!calls.length) {
      return finish({ text: typeof assistant.content === 'string' ? assistant.content.trim() : '' })
    }
    if (round === maxToolRounds) {
      return finish({ text: MESSAGES.toolRoundLimit })
    }

    for (const call of calls) {
      const name = call?.function?.name
      const id = typeof call?.id === 'string' ? call.id : `call_${round}`
      let content
      const startedAt = Date.now()
      try {
        const args = parseToolArguments(call?.function?.arguments)
        // Capability integrations own their execution lifecycle, including any timeout
        // and user-facing timeout reply required by the target plugin.
        const result = await registry.invoke(name, args, context)
        content = toSafeToolContent(result)
        audit({ requestId, userId, tool: name, ok: true, durationMs: Date.now() - startedAt })
        if (result?.handled === true) return finish({ text: '', handled: true, reply: result.reply })
      } catch (error) {
        content = toolErrorContent(error)
        if (!(error instanceof CapabilityError)) {
          global.logger?.error?.(`[pawpilot-plugin] request=${requestId} tool=${typeof name === 'string' ? name : 'invalid'} threw`, error)
        }
        audit({
          requestId,
          userId,
          tool: typeof name === 'string' ? name : 'invalid',
          ok: false,
          code: error?.code ?? 'TOOL_FAILED',
          durationMs: Date.now() - startedAt
        })
      }
      messages.push({ role: 'tool', tool_call_id: id, content })
    }
  }
  return finish({ text: MESSAGES.incomplete })
}
