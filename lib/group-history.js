import {
  normalizeGroupHistoryMessage,
  trimGroupEventCandidates
} from './group-context.js'

function positiveInteger (value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function idOf (value) {
  return value == null ? '' : String(value)
}

function isCurrentMessage (message, event) {
  const messageId = idOf(message?.message_id)
  const eventMessageId = idOf(event?.message_id)
  if (messageId && eventMessageId) return messageId === eventMessageId
  const messageSeq = idOf(message?.message_seq)
  const eventMessageSeq = idOf(event?.message_seq)
  return Boolean(messageSeq && eventMessageSeq && messageSeq === eventMessageSeq)
}

function compareHistoryEvents (left, right) {
  if (left.timestamp && right.timestamp && left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
  if (left.messageSeq != null && right.messageSeq != null && left.messageSeq !== right.messageSeq) {
    return left.messageSeq - right.messageSeq
  }
  return left.orderIndex - right.orderIndex
}

/** Best-effort adapter history snapshot preceding the current group request. */
export async function getGroupHistory (event, maxMessages = 64, maxChars = 6000) {
  if (!event?.isGroup || typeof event?.group?.getChatHistory !== 'function') return []
  maxMessages = positiveInteger(maxMessages, 64)
  maxChars = positiveInteger(maxChars, 6000)
  try {
    const messages = await event.group.getChatHistory(event.message_seq ?? 0, maxMessages + 1, true)
    if (!Array.isArray(messages)) return []
    const events = messages
      .filter(message => !isCurrentMessage(message, event))
      .map((message, index) => normalizeGroupHistoryMessage(message, event, index))
      .filter(Boolean)
      .sort(compareHistoryEvents)
      .slice(-maxMessages)
    return trimGroupEventCandidates(events, maxChars)
  } catch {
    global.logger?.debug?.(`[pawpilot-plugin] group history recovery unavailable group=${event.group_id}`)
    return []
  }
}
