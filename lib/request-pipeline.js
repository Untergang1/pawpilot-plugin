import crypto from 'node:crypto'
import { runFunctionCalling } from './agent-runner.js'
import { ConversationStore } from './conversation-store.js'
import { summarizeDropped, summaryMessage } from './conversation-summary.js'
import {
  buildGroupModelMessages,
  createAssistantGroupEvent,
  createCurrentGroupEvent
} from './group-context.js'
import { getGroupHistory } from './group-history.js'
import { GroupRequestQueue } from './group-request-queue.js'
import { MESSAGES } from './messages.js'
import { ModelClientError } from './model-client.js'
import { getPrivateHistory } from './private-history.js'
import { createModelClient } from './providers.js'
import { RequestLimiter } from './rate-limit.js'
import { buildUserMessage, getReplyContext, getReplyText } from './reply-context.js'

const CHATGPT_REAUTH_CODES = new Set(['NOT_LOGGED_IN', 'REAUTH_REQUIRED', 'CREDENTIALS_INVALID'])

function audit (record) {
  const method = record.ok ? 'mark' : 'warn'
  const text = `[pawpilot-plugin] request=${record.requestId} user=${record.userId} tool=${record.tool} ok=${record.ok} durationMs=${record.durationMs}${record.code ? ` code=${record.code}` : ''}`
  global.logger?.[method]?.(text)
}

function logUsage (requestId, provider, conversationType, usage) {
  if (!usage) return
  global.logger?.mark?.(`[pawpilot-plugin] request=${requestId} usage provider=${provider} type=${conversationType} calls=${usage.modelCalls} input=${usage.inputTokens} cached=${usage.cachedTokens} output=${usage.outputTokens} reasoning=${usage.reasoningTokens}`)
}

export function publicErrorMessage (error) {
  if (!(error instanceof ModelClientError)) return MESSAGES.error.unavailable
  if (error.code === 'API_KEY_MISSING') return MESSAGES.error.apiKeyMissing
  if (error.provider === 'chatgpt' && CHATGPT_REAUTH_CODES.has(error.code)) return MESSAGES.error.chatgptReauth
  if (error.code === 'USAGE_LIMIT') return MESSAGES.error.usageLimit
  if (error.code === 'RATE_LIMITED') return MESSAGES.error.rateLimited
  return MESSAGES.error.unavailable
}

/** Private chats are keyed by user and group chats by group, both per bot account. */
export function sessionScope (event) {
  const groupId = event.isGroup && event.group_id ? String(event.group_id) : undefined
  return { selfId: event.self_id, userId: String(event.user_id), groupId }
}

// Routes requests from one conversation to the same provider prompt cache without
// sending raw QQ/WeChat identifiers to the model provider.
function promptCacheKey ({ selfId, userId, groupId }) {
  const raw = groupId ? `${selfId}:group:${groupId}` : `${selfId}:private:${userId}`
  return `pawpilot-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)}`
}

function isSelfMessage (event) {
  return event?.self_id != null && event?.user_id != null &&
    String(event.user_id) === String(event.self_id)
}

/** Private messages and group @Bot messages that are not `#` commands. */
export function isAgentMessage (event) {
  // Ignore the bot's own messages (e.g. echoed sends) to avoid reply loops.
  if (isSelfMessage(event)) return false
  const message = typeof event?.msg === 'string' ? event.msg.trim() : ''
  if (!message && event?.reply_id == null) return false
  if (message.startsWith('#')) return false
  if (event.isPrivate) return true
  return event.isGroup && event.atBot === true
}

function sendSucceeded (result) {
  return result !== false && result != null && !result?.error
}

/**
 * Runs one natural-language request from admission (rate limits, group FIFO) through
 * context assembly, the function-calling loop, the reply and history bookkeeping.
 * Yunzai specifics are injected so the whole flow can be tested with fakes:
 * `getRegistry(config)` returns the loaded capability registry, `isOwner(event)`
 * decides owner-only capabilities, and `reply(text)` sends a quoted reply.
 */
export function createRequestPipeline ({
  getRegistry,
  isOwner,
  conversations = new ConversationStore(),
  limiter = new RequestLimiter(),
  groupQueue = new GroupRequestQueue(),
  createClient = createModelClient,
  runner = runFunctionCalling
}) {
  function withSummary (scope, messages) {
    const summary = summaryMessage(conversations.getSummary(scope))
    return summary ? [summary, ...messages] : messages
  }

  /**
   * Folds turns dropped by trimming into the session summary in the background, so
   * the reply is never delayed. Failures keep the dropped text for the next attempt.
   */
  function scheduleSummary (scope, client, config, requestId) {
    if (config.conversationSummaryEnabled === false) return
    const claim = conversations.takeDropped(scope)
    if (!claim) return
    summarizeDropped({ client, summary: claim.summary, dropped: claim.dropped, maxChars: config.conversationSummaryMaxChars })
      .then(({ summary, usage }) => {
        conversations.finishSummary(claim, summary)
        logUsage(requestId, config.provider, 'summary', usage && { modelCalls: 1, ...usage })
      })
      .catch(error => {
        conversations.finishSummary(claim, null)
        global.logger?.warn?.(`[pawpilot-plugin] request=${requestId} summary failed code=${error?.code ?? 'UNKNOWN'}`)
      })
  }

  async function buildGroupContext (event, scope, userText, config) {
    const reply = await getReplyContext(event)
    const currentEvent = createCurrentGroupEvent(event, userText, reply)
    const historyEvents = config.groupHistoryRecoveryEnabled !== false
      ? await getGroupHistory(
        event,
        config.groupHistoryRecoveryMaxMessages,
        config.groupHistoryRecoveryMaxChars,
        conversations.getResetAt(scope)
      )
      : []
    const { contextMessages, currentMessage } = buildGroupModelMessages({
      turns: conversations.getTurns(scope),
      historyEvents,
      currentEvent,
      maxHistoryChars: config.conversationMaxChars,
      maxInputChars: config.maxInputChars,
      nameEnabled: config.groupParticipantNameEnabled !== false
    })
    return {
      conversationType: 'group',
      currentMessage,
      contextMessages,
      commit: (text, sendResult) => conversations.appendTurn(
        scope,
        { ...currentEvent, source: 'completed_bot_turn' },
        createAssistantGroupEvent(event, text, sendResult)
      )
    }
  }

  async function buildPrivateContext (event, scope, userText, config) {
    const message = buildUserMessage(userText, await getReplyText(event), config.maxInputChars)
    if (!message) return { immediateReply: MESSAGES.emptyMessage }
    const cachedHistory = conversations.getMessages(scope)
    const recoveredHistory = cachedHistory.length || config.conversationHistoryRecoveryEnabled === false
      ? []
      : await getPrivateHistory(event, config.conversationHistoryRecoveryMaxMessages, conversations.getResetAt(scope))
    return {
      conversationType: 'private',
      currentMessage: { role: 'user', content: message },
      contextMessages: cachedHistory.length ? cachedHistory : recoveredHistory,
      commit: text => {
        conversations.hydrateMessages(scope, recoveredHistory)
        conversations.appendExchange(scope, message, text)
      }
    }
  }

  async function processRequest (event, { config, scope, userText, requestId, reply }) {
    try {
      const client = createClient(config)
      const registry = await getRegistry(config)
      const context = scope.groupId
        ? await buildGroupContext(event, scope, userText, config)
        : await buildPrivateContext(event, scope, userText, config)
      if (context.immediateReply) return reply(context.immediateReply)

      const result = await runner({
        client,
        registry,
        conversationType: context.conversationType,
        event,
        userId: scope.userId,
        groupId: scope.groupId,
        isOwner: isOwner(event),
        currentMessage: context.currentMessage,
        contextMessages: withSummary(scope, context.contextMessages),
        requestId,
        cacheKey: promptCacheKey(scope),
        maxToolRounds: config.maxToolRounds,
        audit
      })
      logUsage(requestId, config.provider, context.conversationType, result.usage)
      if (result.handled) return true
      const text = result.text || MESSAGES.emptyReply
      const sendResult = await reply(text)
      if (sendSucceeded(sendResult)) {
        context.commit(text, sendResult)
        scheduleSummary(scope, client, config, requestId)
      }
      return sendResult
    } catch (error) {
      global.logger?.warn?.(`[pawpilot-plugin] request=${requestId} failed code=${error?.code ?? 'UNKNOWN'}${error?.providerCode ? ` providerCode=${error.providerCode}` : ''} message=${error?.message ?? ''}`)
      return reply(publicErrorMessage(error))
    }
  }

  return {
    conversations,

    /**
     * Handles a candidate event with a normalized config. Returns false when the
     * event is not for the agent, otherwise the reply result.
     */
    async handle (event, config, reply) {
      if (!isAgentMessage(event) || config.enabled === false) return false
      limiter.windowMs = config.rateLimitWindowMs
      limiter.maxRequests = config.rateLimitMaxRequests
      limiter.maxConcurrent = config.rateLimitMaxConcurrent
      conversations.configure({
        maxTurns: config.conversationHistoryTurns,
        ttlMs: config.conversationTtlMinutes * 60_000,
        maxChars: config.conversationMaxChars
      })

      const userText = typeof event.msg === 'string' ? event.msg.trim() : ''
      if (userText.length > config.maxInputChars) return reply(MESSAGES.inputTooLong(config.maxInputChars))
      const scope = sessionScope(event)
      const request = { config, scope, userText, requestId: crypto.randomUUID(), reply }

      if (scope.groupId) {
        const rate = limiter.consume(`${event.self_id}:group:${scope.groupId}:user:${scope.userId}`)
        if (!rate.ok) return reply(MESSAGES.rateLimited)
        const queued = groupQueue.enqueue(
          `bot:${event.self_id}:group:${scope.groupId}`,
          () => processRequest(event, request),
          config.groupRequestQueueMaxOutstanding
        )
        if (!queued.ok) return reply(MESSAGES.groupBusy)
        return queued.promise
      }

      const lock = limiter.acquire(`${event.self_id}:private:${scope.userId}`)
      if (!lock.ok) return reply(lock.reason === 'BUSY' ? MESSAGES.privateBusy : MESSAGES.rateLimited)
      try {
        return await processRequest(event, request)
      } finally {
        lock.release()
      }
    },

    /** Clears the event's conversation and returns the confirmation text. */
    reset (event) {
      const scope = sessionScope(event)
      conversations.reset(scope)
      return scope.groupId ? MESSAGES.resetGroup : MESSAGES.resetPrivate
    }
  }
}
