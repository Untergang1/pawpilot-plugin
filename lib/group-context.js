import crypto from 'node:crypto'
import {
  explicitReplyId,
  messageSenderId,
  messageSenderName,
  replyToText
} from './reply-context.js'
import { compareChronological, finiteNumber, idOf, normalizedTimestamp, shortLocalTime } from './util.js'

export function sanitizeDisplayName (value, fallback = 'Unknown') {
  const text = String(value || fallback)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return (text || fallback).slice(0, 80)
}

export function groupParticipantName (selfId, groupId, senderId, isBot = false) {
  if (isBot) return 'bot'
  const raw = idOf(senderId)
  if (/^[A-Za-z0-9_]{1,48}$/u.test(raw)) return `member_${raw}`
  const hash = crypto.createHash('sha256').update(`${selfId}:${groupId}:${raw}`).digest('hex').slice(0, 16)
  return `member_${hash}`
}

function messageIdsOf (value) {
  const values = Array.isArray(value) ? value : [value]
  return [...new Set(values.flat().map(idOf).filter(Boolean))]
}

function replyPreview (message) {
  if (!Array.isArray(message?.message)) return ''
  const segment = message.message.find(item => item?.type === 'reply')
  if (!segment) return ''
  const data = segment.data && typeof segment.data === 'object' ? segment.data : segment
  return typeof data.text === 'string' ? data.text.trim() : ''
}

export function normalizeGroupHistoryMessage (message, event, orderIndex = 0) {
  if (!message || typeof message !== 'object') return null
  const senderId = messageSenderId(message)
  const content = replyToText(message)
  const replyId = explicitReplyId(message)
  if (!senderId || (!content && !replyId)) return null
  const isBot = senderId === idOf(event?.self_id)
  const preview = replyPreview(message)
  return {
    role: isBot ? 'assistant' : 'user',
    participantName: groupParticipantName(event?.self_id, event?.group_id, senderId, isBot),
    senderId,
    senderName: sanitizeDisplayName(messageSenderName(message, senderId), `用户 ${senderId}`),
    content,
    messageId: idOf(message.message_id),
    messageIds: messageIdsOf(message.message_id),
    messageSeq: finiteNumber(message.message_seq),
    timestamp: normalizedTimestamp(message.time ?? message.timestamp),
    source: 'group_history',
    directToBot: false,
    reply: replyId
      ? { messageId: replyId, content: preview, available: Boolean(preview) }
      : undefined,
    orderIndex
  }
}

export function createCurrentGroupEvent (event, content, reply) {
  const senderId = idOf(event?.user_id)
  return {
    role: 'user',
    participantName: groupParticipantName(event?.self_id, event?.group_id, senderId),
    senderId,
    senderName: sanitizeDisplayName(messageSenderName(event, senderId), `用户 ${senderId}`),
    content: typeof content === 'string' ? content.trim() : '',
    messageId: idOf(event?.message_id),
    messageIds: messageIdsOf(event?.message_id),
    messageSeq: finiteNumber(event?.message_seq),
    timestamp: normalizedTimestamp(event?.time ?? event?.timestamp, Date.now()),
    source: 'current_request',
    directToBot: true,
    reply: reply
      ? {
          ...reply,
          senderName: sanitizeDisplayName(reply.senderName, reply.senderId ? `用户 ${reply.senderId}` : 'Unknown')
        }
      : undefined,
    orderIndex: Number.MAX_SAFE_INTEGER - 1
  }
}

export function createAssistantGroupEvent (event, content, sendResult) {
  const messageIds = messageIdsOf(sendResult?.message_id ?? sendResult?.messageId)
  return {
    role: 'assistant',
    participantName: 'bot',
    senderId: idOf(event?.self_id),
    senderName: 'Bot',
    content: typeof content === 'string' ? content.trim() : '',
    messageId: messageIds[0] ?? '',
    messageIds,
    messageSeq: finiteNumber(sendResult?.message_seq),
    timestamp: Date.now(),
    source: 'completed_bot_turn',
    directToBot: true,
    orderIndex: Number.MAX_SAFE_INTEGER
  }
}

function sourceLabel (event) {
  if (event.source === 'current_request') return 'Current direct request'
  if (event.source === 'completed_bot_turn') {
    return event.role === 'assistant' ? 'Completed bot reply' : 'Completed direct interaction'
  }
  return 'Background group message'
}

/**
 * Short, stable reference for a message id. It stays identical across requests so
 * repeated history keeps the same text, and lets replies point at context messages
 * without spending tokens on raw platform ids.
 */
export function messageRef (messageId) {
  const id = idOf(messageId)
  return id ? crypto.createHash('sha256').update(id).digest('hex').slice(0, 6) : ''
}

function senderLabel (name, id) {
  return `${name} (${id})`
}

// Absolute send time rather than "N minutes ago", so a message's label stays
// identical across requests and keeps provider prompt-cache prefixes stable.
function metadataLine (event) {
  const ref = messageRef(event.messageId)
  const time = event.timestamp ? ` at ${shortLocalTime(event.timestamp)}` : ''
  return `[${sourceLabel(event)}${ref ? ` #${ref}` : ''}${time} from ${senderLabel(event.senderName, event.senderId)}]`
}

function replyHeader (reply) {
  if (!reply?.messageId) return ''
  const sender = reply.senderId
    ? ` from ${senderLabel(sanitizeDisplayName(reply.senderName, `用户 ${reply.senderId}`), reply.senderId)}`
    : ''
  return `[Explicit reply to #${messageRef(reply.messageId)}${sender}]`
}

function composeContent (event, quote, body) {
  const parts = [metadataLine(event)]
  const header = replyHeader(event.reply)
  if (header) parts.push(header)
  if (quote) {
    parts.push('--- quoted content ---')
    parts.push(quote)
    parts.push('--- end quoted content ---')
  } else if (event.reply?.messageId && event.reply.available === false && !event.reply.resolvedInContext) {
    parts.push('[quoted content unavailable]')
  }
  if (body) parts.push(body)
  return parts.join('\n')
}

function truncateText (text, maxChars, marker) {
  if (text.length <= maxChars) return text
  if (maxChars <= marker.length) return marker.slice(0, maxChars)
  return `${text.slice(0, maxChars - marker.length)}${marker}`
}

export function formatGroupEvent (event, { nameEnabled = true, maxChars = Infinity } = {}) {
  let body = typeof event?.content === 'string' ? event.content.trim() : ''
  let quote = event?.reply?.available && typeof event.reply.content === 'string'
    ? event.reply.content.trim()
    : ''
  let content = composeContent(event, quote, body)

  if (Number.isFinite(maxChars) && content.length > maxChars) {
    const withoutQuote = composeContent(event, '', body)
    if (quote && withoutQuote.length < maxChars) {
      const quoteBudget = Math.max(0, maxChars - withoutQuote.length - 70)
      quote = truncateText(quote, quoteBudget, '\n[quoted message truncated]')
      content = composeContent(event, quote, body)
    } else {
      quote = ''
      const fixed = composeContent(event, '', '')
      const bodyBudget = Math.max(0, maxChars - fixed.length - 1)
      body = truncateText(body, bodyBudget, '\n[group message truncated]')
      content = composeContent(event, '', body)
    }
    if (content.length > maxChars) content = content.slice(0, maxChars)
  }

  const modelMessage = { role: event.role, content }
  if (nameEnabled && /^[A-Za-z0-9_]{1,64}$/u.test(event.participantName || '')) {
    modelMessage.name = event.participantName
  }
  return modelMessage
}

export function estimateGroupEventChars (event) {
  return formatGroupEvent(event).content.length
}

export function trimGroupEventCandidates (events, maxChars) {
  let remaining = Number(maxChars)
  if (!Number.isFinite(remaining) || remaining <= 0) return []
  const kept = []
  for (let index = events.length - 1; index >= 0 && remaining > 0; index -= 1) {
    let event = events[index]
    let size = estimateGroupEventChars(event)
    if (size > remaining && kept.length) break
    if (size > remaining) {
      event = cloneEvent(event)
      if (event.reply?.content) {
        const excess = Math.max(0, estimateGroupEventChars(event) - remaining)
        event.reply.content = event.reply.content.slice(0, Math.max(0, event.reply.content.length - excess))
        event.reply.available = Boolean(event.reply.content)
      }
      if (estimateGroupEventChars(event) > remaining) {
        const excess = estimateGroupEventChars(event) - remaining
        event.content = event.content.slice(0, Math.max(0, event.content.length - excess - 26))
        if (event.content) event.content += '\n[group message truncated]'
      }
      size = estimateGroupEventChars(event)
    }
    kept.unshift(event)
    remaining -= Math.min(size, remaining)
  }
  return kept
}

function eventIds (event) {
  return messageIdsOf([event?.messageId, ...(event?.messageIds ?? [])])
}

function cloneEvent (event) {
  return {
    ...event,
    messageIds: [...(event?.messageIds ?? [])],
    reply: event?.reply ? { ...event.reply } : undefined
  }
}

function mergeStoredWithAdapter (stored, adapter) {
  return {
    ...adapter,
    ...stored,
    senderId: adapter.senderId || stored.senderId,
    senderName: adapter.senderName || stored.senderName,
    messageId: adapter.messageId || stored.messageId,
    messageIds: [...new Set([...eventIds(adapter), ...eventIds(stored)])],
    messageSeq: adapter.messageSeq ?? stored.messageSeq,
    timestamp: adapter.timestamp || stored.timestamp,
    reply: stored.reply || adapter.reply
      ? { ...(adapter.reply ?? {}), ...(stored.reply ?? {}) }
      : undefined
  }
}

export function mergeGroupEvents (turns, historyEvents) {
  const storedEvents = Array.isArray(turns)
    ? turns.flatMap(turn => [turn?.user, turn?.assistant]).filter(event => event && typeof event === 'object')
    : []
  const events = storedEvents.map(cloneEvent)
  const indexById = new Map()
  events.forEach((event, index) => eventIds(event).forEach(id => indexById.set(id, index)))

  for (const adapterEvent of Array.isArray(historyEvents) ? historyEvents : []) {
    const duplicateIndex = eventIds(adapterEvent).map(id => indexById.get(id)).find(index => index != null)
    if (duplicateIndex == null) {
      const index = events.push(cloneEvent(adapterEvent)) - 1
      eventIds(adapterEvent).forEach(id => indexById.set(id, index))
      continue
    }
    events[duplicateIndex] = mergeStoredWithAdapter(events[duplicateIndex], adapterEvent)
    eventIds(events[duplicateIndex]).forEach(id => indexById.set(id, duplicateIndex))
  }

  const byId = new Map()
  events.forEach(event => eventIds(event).forEach(id => byId.set(id, event)))
  for (const event of events) {
    const target = event.reply?.messageId ? byId.get(event.reply.messageId) : undefined
    if (target) {
      event.reply = {
        ...event.reply,
        senderId: event.reply.senderId || target.senderId,
        senderName: event.reply.senderName || target.senderName,
        resolvedInContext: true
      }
    }
  }
  return events.sort(compareChronological)
}

export function buildGroupModelMessages ({
  turns = [],
  historyEvents = [],
  currentEvent,
  maxHistoryChars = 12_000,
  maxInputChars = 4000,
  nameEnabled = true
}) {
  const events = mergeGroupEvents(turns, historyEvents)
  let remaining = Number(maxHistoryChars)
  const contextMessages = []
  for (let index = events.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const full = formatGroupEvent(events[index], { nameEnabled })
    if (full.content.length <= remaining) {
      contextMessages.unshift(full)
      remaining -= full.content.length
      continue
    }
    if (!contextMessages.length) {
      contextMessages.unshift(formatGroupEvent(events[index], { nameEnabled, maxChars: remaining }))
    }
    break
  }
  return {
    contextMessages,
    currentMessage: formatGroupEvent(currentEvent, { nameEnabled, maxChars: maxInputChars })
  }
}
