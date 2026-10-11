import crypto from 'node:crypto'
import cfg from '../../lib/config/config.js'
import { CapabilityModuleLoader } from './lib/capability-loader.js'
import { getAgentConfig } from './lib/config.js'
import { QwenClient, QwenClientError } from './lib/qwen-client.js'
import { ChatGPTClient, ChatGPTClientError } from './lib/chatgpt-client.js'
import { ChatGPTAuthError } from './lib/chatgpt-auth.js'
import { RequestLimiter } from './lib/rate-limit.js'
import { GroupRequestQueue } from './lib/group-request-queue.js'
import { runFunctionCalling } from './lib/agent-runner.js'
import { ConversationStore } from './lib/conversation-store.js'
import { getGroupHistory } from './lib/group-history.js'
import { getPrivateHistory } from './lib/private-history.js'
import { buildUserMessage, getReplyContext, getReplyText } from './lib/reply-context.js'
import {
  buildGroupModelMessages,
  createAssistantGroupEvent,
  createCurrentGroupEvent
} from './lib/group-context.js'

const registryLoader = new CapabilityModuleLoader()
const limiter = new RequestLimiter()
const groupQueue = new GroupRequestQueue()
const conversations = new ConversationStore()
let loadedModuleKey = ''

function audit (record) {
  const method = record.ok ? 'mark' : 'warn'
  const text = `[pawpilot-plugin] request=${record.requestId} user=${record.userId} tool=${record.tool} ok=${record.ok} durationMs=${record.durationMs}${record.code ? ` code=${record.code}` : ''}`
  global.logger?.[method]?.(text)
}

function getConfig () {
  const config = getAgentConfig()
  const moduleIds = config.capabilityModules
  const moduleKey = moduleIds.join(',')
  return { config, moduleIds, moduleKey }
}

function createModelClient (config) {
  if (config.provider === 'chatgpt') {
    const { chatgpt } = config
    return new ChatGPTClient({
      credentialsFile: typeof chatgpt.credentialsFile === 'string' && chatgpt.credentialsFile
        ? chatgpt.credentialsFile
        : undefined,
      model: typeof chatgpt.model === 'string' ? chatgpt.model : undefined,
      reasoningEffort: typeof chatgpt.reasoningEffort === 'string' ? chatgpt.reasoningEffort : undefined,
      timeoutMs: chatgpt.requestTimeoutMs
    })
  }
  if (config.provider !== 'dashscope') {
    throw new QwenClientError('Unknown model provider', 'INVALID_PROVIDER')
  }
  const { dashscope } = config
  const apiKey = process.env.DASHSCOPE_API_KEY || dashscope.apiKey
  if (!apiKey) throw new QwenClientError('DashScope API key is not configured', 'API_KEY_MISSING')
  return new QwenClient({
    apiKey,
    baseURL: dashscope.baseURL,
    model: dashscope.model,
    timeoutMs: dashscope.requestTimeoutMs
  })
}

function publicErrorMessage (error) {
  if (error instanceof QwenClientError && error.code === 'API_KEY_MISSING') {
    return 'AI 服务尚未配置 API Key。请设置 DASHSCOPE_API_KEY 或 pawpilot-plugin/config/config.yaml 中的 dashscope.apiKey。'
  }
  if (error instanceof ChatGPTAuthError &&
      ['NOT_LOGGED_IN', 'REAUTH_REQUIRED', 'CREDENTIALS_INVALID'].includes(error.code)) {
    return 'AI 服务的 ChatGPT 登录已失效，请主人按 pawpilot-plugin 文档重新运行登录脚本。'
  }
  if (error instanceof ChatGPTClientError && error.code === 'USAGE_LIMIT') {
    return 'AI 服务的 ChatGPT 套餐额度暂时用尽，请稍后再试。'
  }
  return 'AI 服务暂时不可用，请稍后重试。'
}

function sessionScope (event, userId, groupId) {
  return { selfId: event.self_id, userId, groupId }
}

async function ensureCapabilities (moduleIds, moduleKey) {
  if (moduleKey === loadedModuleKey) return
  registryLoader.moduleIds = moduleIds
  await registryLoader.reload()
  loadedModuleKey = moduleKey
}

function isOwner (event) {
  if (event.isMaster === true) return true
  const owners = cfg.master?.[event.self_id] ?? []
  return owners.includes(String(event.user_id))
}

function isSelfMessage (event) {
  return event?.self_id != null && event?.user_id != null &&
    String(event.user_id) === String(event.self_id)
}

function isAgentMessage (event) {
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

export class pawPilot extends plugin {
  constructor () {
    super({
      name: 'PawPilot',
      dsc: 'LLM function-calling assistant (DashScope or ChatGPT)',
      event: 'message',
      priority: 900,
      rule: [{ reg: '^#ai\\s*reload$', fnc: 'reloadCapabilities', permission: 'master' }]
    })
  }

  async reloadCapabilities () {
    try {
      const { moduleIds, moduleKey } = getConfig()
      registryLoader.moduleIds = moduleIds
      const capabilities = await registryLoader.reload()
      loadedModuleKey = moduleKey
      return this.reply(`AI 能力及集成提示词已重载：${capabilities.map(item => item.name).join('、') || '无'}`, true)
    } catch (error) {
      global.logger?.error?.('[pawpilot-plugin] capability reload failed', error)
      return this.reply('AI 能力重载失败，请检查安全日志和能力模块配置。', true)
    }
  }

  async accept (event) {
    if (!isAgentMessage(event)) return false
    const { config, moduleIds, moduleKey } = getConfig()
    if (config.enabled === false) return false
    limiter.windowMs = config.rateLimitWindowMs
    limiter.maxRequests = config.rateLimitMaxRequests
    limiter.maxConcurrent = config.rateLimitMaxConcurrent
    conversations.configure({
      maxTurns: config.conversationHistoryTurns,
      ttlMs: config.conversationTtlMinutes * 60_000,
      maxChars: config.conversationMaxChars
    })

    const userText = typeof event.msg === 'string' ? event.msg.trim() : ''
    const { maxInputChars } = config
    if (userText.length > maxInputChars) {
      return this.reply(`消息过长，请控制在 ${maxInputChars} 个字符以内。`, true)
    }
    const requestId = crypto.randomUUID()
    const userId = String(event.user_id)
    const groupId = event.group_id ? String(event.group_id) : undefined
    const scope = sessionScope(event, userId, groupId)

    if (event.isGroup && groupId) {
      const rate = limiter.consume(`${event.self_id}:group:${groupId}:user:${userId}`)
      if (!rate.ok) return this.reply('请求过于频繁，请稍后再试。', true)
      const queued = groupQueue.enqueue(
        `bot:${event.self_id}:group:${groupId}`,
        () => this.processAgentRequest(event, {
          config,
          moduleIds,
          moduleKey,
          requestId,
          userId,
          groupId,
          scope,
          userText,
          maxInputChars
        }),
        config.groupRequestQueueMaxOutstanding
      )
      if (!queued.ok) return this.reply('当前群的 AI 请求较多，请稍后再试。', true)
      return queued.promise
    }

    const lock = limiter.acquire(`${event.self_id}:private:${userId}`)
    if (!lock.ok) {
      return this.reply(lock.reason === 'BUSY' ? '上一条 AI 请求仍在处理中。' : '请求过于频繁，请稍后再试。', true)
    }

    try {
      return await this.processAgentRequest(event, {
        config,
        moduleIds,
        moduleKey,
        requestId,
        userId,
        groupId,
        scope,
        userText,
        maxInputChars
      })
    } finally {
      lock.release()
    }
  }

  async processAgentRequest (event, {
    config,
    moduleIds,
    moduleKey,
    requestId,
    userId,
    groupId,
    scope,
    userText,
    maxInputChars
  }) {
    try {
      const client = createModelClient(config)
      await ensureCapabilities(moduleIds, moduleKey)

      if (event.isGroup && groupId) {
        const reply = await getReplyContext(event)
        const currentEvent = createCurrentGroupEvent(event, userText, reply)
        const historyEvents = config.groupHistoryRecoveryEnabled !== false
          ? await getGroupHistory(
            event,
            config.groupHistoryRecoveryMaxMessages,
            config.groupHistoryRecoveryMaxChars
          )
          : []
        const { contextMessages, currentMessage } = buildGroupModelMessages({
          turns: conversations.getTurns(scope),
          historyEvents,
          currentEvent,
          maxHistoryChars: config.conversationMaxChars,
          maxInputChars,
          nameEnabled: config.groupParticipantNameEnabled !== false
        })
        const result = await runFunctionCalling({
          client,
          registry: registryLoader.registry,
          conversationType: 'group',
          event,
          userId,
          groupId,
          isOwner: isOwner(event),
          currentMessage,
          contextMessages,
          requestId,
          maxToolRounds: config.maxToolRounds,
          audit
        })
        if (result.handled) return true
        const text = result.text || '我没有生成可发送的回复，请换一种问法。'
        const sendResult = await this.reply(text, true)
        if (sendSucceeded(sendResult)) {
          conversations.appendTurn(
            scope,
            { ...currentEvent, source: 'completed_bot_turn' },
            createAssistantGroupEvent(event, text, sendResult)
          )
        }
        return sendResult
      }

      const replyText = await getReplyText(event)
      const message = buildUserMessage(userText, replyText, maxInputChars)
      if (!message) return this.reply('你好，请直接告诉我需要什么帮助。', true)
      const cachedHistory = conversations.getMessages(scope)
      const recoveredHistory = cachedHistory.length || config.conversationHistoryRecoveryEnabled === false
        ? []
        : await getPrivateHistory(event, config.conversationHistoryRecoveryMaxMessages)
      const result = await runFunctionCalling({
        client,
        registry: registryLoader.registry,
        conversationType: 'private',
        event,
        userId,
        groupId,
        isOwner: isOwner(event),
        userMessage: message,
        contextMessages: cachedHistory.length ? cachedHistory : recoveredHistory,
        requestId,
        maxToolRounds: config.maxToolRounds,
        audit
      })
      if (result.handled) return true
      const text = result.text || '我没有生成可发送的回复，请换一种问法。'
      const sendResult = await this.reply(text, true)
      if (sendSucceeded(sendResult)) {
        conversations.hydrateMessages(scope, recoveredHistory)
        conversations.appendExchange(scope, message, text)
      }
      return sendResult
    } catch (error) {
      const publicMessage = publicErrorMessage(error)
      global.logger?.warn?.(`[pawpilot-plugin] request=${requestId} failed code=${error?.code ?? 'UNKNOWN'} message=${error?.message ?? ''}`)
      return this.reply(publicMessage, true)
    }
  }
}
