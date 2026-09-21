const DEFAULT_MAX_TURNS = 12
const DEFAULT_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_CHARS = 12_000

function positiveInteger (value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function cloneValue (value) {
  if (!value || typeof value !== 'object') return value
  return {
    ...value,
    messageIds: Array.isArray(value.messageIds) ? [...value.messageIds] : value.messageIds,
    reply: value.reply ? { ...value.reply } : undefined
  }
}

function valueChars (value) {
  if (typeof value === 'string') return value.length
  if (!value || typeof value !== 'object') return 0
  return JSON.stringify(value).length
}

function trimValue (value, maxChars) {
  if (typeof value === 'string') return value.slice(-maxChars)
  if (!value || typeof value !== 'object') return value
  const trimmed = cloneValue(value)
  if (trimmed.reply?.content) {
    const excess = Math.max(0, valueChars(trimmed) - maxChars)
    if (excess) trimmed.reply.content = trimmed.reply.content.slice(0, Math.max(0, trimmed.reply.content.length - excess))
  }
  if (valueChars(trimmed) > maxChars && typeof trimmed.content === 'string') {
    const metadataChars = valueChars({ ...trimmed, content: '' })
    trimmed.content = trimmed.content.slice(-Math.max(0, maxChars - metadataChars))
  }
  return trimmed
}

/**
 * Process-local short-term conversation memory. It intentionally contains only
 * completed text exchanges; tool arguments and tool results are never retained.
 */
export class ConversationStore {
  constructor ({ maxTurns = DEFAULT_MAX_TURNS, ttlMs = DEFAULT_TTL_MS, maxChars = DEFAULT_MAX_CHARS } = {}) {
    this.sessions = new Map()
    this.configure({ maxTurns, ttlMs, maxChars })
  }

  configure ({ maxTurns, ttlMs, maxChars } = {}) {
    this.maxTurns = positiveInteger(maxTurns, DEFAULT_MAX_TURNS)
    this.ttlMs = positiveInteger(ttlMs, DEFAULT_TTL_MS)
    this.maxChars = positiveInteger(maxChars, DEFAULT_MAX_CHARS)
  }

  getMessages (scope) {
    const session = this.#getLiveSession(scope)
    if (!session) return []
    return [
      ...(session.recovered ?? []),
      ...session.turns.flatMap(turn => [
        typeof turn.user === 'string' ? { role: 'user', content: turn.user } : cloneValue(turn.user),
        typeof turn.assistant === 'string' ? { role: 'assistant', content: turn.assistant } : cloneValue(turn.assistant)
      ])
    ]
  }

  getTurns (scope) {
    const session = this.#getLiveSession(scope)
    if (!session) return []
    return session.turns.map(turn => ({
      user: cloneValue(turn.user),
      assistant: cloneValue(turn.assistant)
    }))
  }

  hydrateMessages (scope, messages) {
    const recovered = Array.isArray(messages)
      ? messages
        .filter(message => (
          (message?.role === 'user' || message?.role === 'assistant') &&
          typeof message.content === 'string' &&
          message.content.trim()
        ))
        .map(message => ({ role: message.role, content: message.content.trim() }))
      : []
    if (!recovered.length) return

    const key = this.#key(scope)
    const session = this.#getLiveSession(scope) ?? { recovered: [], turns: [] }
    if ((session.recovered?.length ?? 0) || session.turns.length) return
    session.recovered = recovered
    session.updatedAt = Date.now()
    this.#trim(session)
    this.sessions.set(key, session)
  }

  appendExchange (scope, user, assistant) {
    if (typeof user !== 'string' || !user.trim() || typeof assistant !== 'string' || !assistant.trim()) return
    const key = this.#key(scope)
    const session = this.#getLiveSession(scope) ?? { recovered: [], turns: [] }
    session.recovered ??= []
    session.turns.push({ user: user.trim(), assistant: assistant.trim() })
    session.updatedAt = Date.now()
    this.#trim(session)
    this.sessions.set(key, session)
  }

  appendTurn (scope, user, assistant) {
    if (!user || typeof user !== 'object' || !assistant || typeof assistant !== 'object') return
    if ((typeof user.content !== 'string' || !user.content.trim()) && !user.reply?.messageId) return
    if (typeof assistant.content !== 'string' || !assistant.content.trim()) return
    const key = this.#key(scope)
    const session = this.#getLiveSession(scope) ?? { recovered: [], turns: [] }
    session.recovered ??= []
    session.turns.push({ user: cloneValue(user), assistant: cloneValue(assistant) })
    session.updatedAt = Date.now()
    this.#trim(session)
    this.sessions.set(key, session)
  }

  clear (scope) {
    this.sessions.delete(this.#key(scope))
  }

  #getLiveSession (scope) {
    const key = this.#key(scope)
    const session = this.sessions.get(key)
    if (!session) return null
    if (Date.now() - session.updatedAt >= this.ttlMs) {
      this.sessions.delete(key)
      return null
    }
    return session
  }

  #key ({ selfId, userId, groupId }) {
    const bot = String(selfId ?? 'default')
    return groupId ? `bot:${bot}:group:${String(groupId)}` : `bot:${bot}:private:${String(userId)}`
  }

  #trim (session) {
    while (session.turns.length > this.maxTurns) session.turns.shift()
    session.recovered ??= []
    let total = this.#totalChars(session)
    while (session.recovered.length && total > this.maxChars) {
      const oldest = session.recovered[0]
      const nonRecoveredChars = total - oldest.content.length
      if (session.recovered.length === 1 && nonRecoveredChars === 0) {
        session.recovered[0].content = session.recovered[0].content.slice(-this.maxChars)
        total = this.#totalChars(session)
        break
      }
      total -= session.recovered.shift().content.length
    }
    while (session.turns.length > 1 && total > this.maxChars) {
      const removed = session.turns.shift()
      total -= valueChars(removed.user) + valueChars(removed.assistant)
    }
    if (session.turns.length === 1 && total > this.maxChars) {
      const [turn] = session.turns
      const perMessage = Math.floor(this.maxChars / 2)
      turn.user = trimValue(turn.user, perMessage)
      turn.assistant = trimValue(turn.assistant, perMessage)
    }
  }

  #totalChars (session) {
    return session.recovered.reduce((sum, message) => sum + message.content.length, 0) +
      session.turns.reduce((sum, turn) => sum + valueChars(turn.user) + valueChars(turn.assistant), 0)
  }
}
