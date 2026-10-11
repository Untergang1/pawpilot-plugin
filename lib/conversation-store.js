import { positiveInteger } from './util.js'

const DEFAULT_MAX_TURNS = 12
const DEFAULT_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_CHARS = 12_000
const TRIM_TARGET = 0.75

function summaryLine (value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const speaker = value.role === 'assistant' ? 'assistant' : value.senderName ? `user ${value.senderName}` : 'user'
  return `${speaker}: ${typeof value.content === 'string' ? value.content : ''}`.trim()
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
    this.resetMarks = new Map()
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

  /**
   * Starts a fresh conversation. The reset time outlives the session TTL so history
   * recovery from the adapter never brings back messages from before the reset.
   */
  reset (scope) {
    const key = this.#key(scope)
    this.sessions.delete(key)
    this.resetMarks.set(key, Date.now())
  }

  getResetAt (scope) {
    return this.resetMarks.get(this.#key(scope)) ?? 0
  }

  getSummary (scope) {
    return this.#getLiveSession(scope)?.summary ?? ''
  }

  /**
   * Claims text dropped by trimming for summarization. Returns null when there is
   * nothing to summarize or a summary for this session is already being produced.
   */
  takeDropped (scope) {
    const session = this.#getLiveSession(scope)
    if (!session?.dropped?.length || session.summarizing) return null
    session.summarizing = true
    const dropped = session.dropped
    session.dropped = []
    return { summary: session.summary ?? '', dropped, session }
  }

  /**
   * Stores the summary for a claim from takeDropped. A failed summary passes null and
   * the claimed text is queued again for the next attempt.
   */
  finishSummary (claim, summary) {
    claim.session.summarizing = false
    if (typeof summary === 'string' && summary.trim()) {
      claim.session.summary = summary.trim()
    } else {
      claim.session.dropped = [...claim.dropped, ...(claim.session.dropped ?? [])]
    }
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

  /**
   * Trims in chunks: once a hard limit is exceeded, oldest content is dropped down to
   * TRIM_TARGET of the limits, so the history prefix stays unchanged across several
   * requests (helping provider prompt caches) and summaries run once per chunk.
   * Dropped text is queued for summarization.
   */
  #trim (session) {
    session.recovered ??= []
    session.dropped ??= []
    let total = this.#totalChars(session)
    if (session.turns.length <= this.maxTurns && total <= this.maxChars) return
    const targetTurns = Math.max(1, Math.floor(this.maxTurns * TRIM_TARGET))
    const targetChars = Math.floor(this.maxChars * TRIM_TARGET)
    while (session.recovered.length && total > targetChars) {
      const removed = session.recovered.shift()
      session.dropped.push(summaryLine(removed))
      total -= removed.content.length
    }
    while (session.turns.length > 1 && (session.turns.length > targetTurns || total > targetChars)) {
      const removed = session.turns.shift()
      session.dropped.push(
        typeof removed.user === 'string' ? `user: ${removed.user}` : summaryLine(removed.user),
        typeof removed.assistant === 'string' ? `assistant: ${removed.assistant}` : summaryLine(removed.assistant)
      )
      total -= valueChars(removed.user) + valueChars(removed.assistant)
    }
    if (total > this.maxChars) {
      if (session.recovered.length) {
        session.recovered[0].content = session.recovered[0].content.slice(-this.maxChars)
      } else if (session.turns.length === 1) {
        const [turn] = session.turns
        const perMessage = Math.floor(this.maxChars / 2)
        turn.user = trimValue(turn.user, perMessage)
        turn.assistant = trimValue(turn.assistant, perMessage)
      }
    }
  }

  #totalChars (session) {
    return session.recovered.reduce((sum, message) => sum + message.content.length, 0) +
      session.turns.reduce((sum, turn) => sum + valueChars(turn.user) + valueChars(turn.assistant), 0)
  }
}
