import { replyToText } from './reply-context.js'

function positiveInteger (value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function idOf (value) {
  return value == null ? '' : String(value)
}

function messageSenderId (message) {
  return message?.user_id ?? message?.sender?.user_id ?? message?.sender?.qq
}

function isCurrentMessage (message, event) {
  const messageId = idOf(message?.message_id)
  const eventMessageId = idOf(event?.message_id)
  if (messageId && eventMessageId) return messageId === eventMessageId

  const messageSeq = idOf(message?.message_seq)
  const eventMessageSeq = idOf(event?.message_seq)
  return Boolean(messageSeq && eventMessageSeq && messageSeq === eventMessageSeq)
}

function messageOrder (message, index) {
  const time = Number(message?.time ?? message?.timestamp)
  const sequence = Number(message?.message_seq)
  return {
    time: Number.isFinite(time) ? time : 0,
    sequence: Number.isFinite(sequence) ? sequence : 0,
    index
  }
}

function timestampMs (time) {
  return time < 10_000_000_000 ? time * 1000 : time
}

function compareHistoryMessages (left, right) {
  if (left.order.time !== right.order.time) return left.order.time - right.order.time
  if (left.order.sequence !== right.order.sequence) return left.order.sequence - right.order.sequence
  return left.order.index - right.order.index
}

function toConversationMessage (message, event, index) {
  if (!message || typeof message !== 'object' || isCurrentMessage(message, event)) return null
  const senderId = idOf(messageSenderId(message))
  const role = senderId === idOf(event?.self_id)
    ? 'assistant'
    : senderId === idOf(event?.user_id)
      ? 'user'
      : ''
  const content = replyToText(message)
  if (!role || !content) return null
  return { role, content, order: messageOrder(message, index) }
}

/**
 * Best-effort recovery for an empty private conversation cache. This relies on
 * optional OneBot adapter extensions and deliberately degrades to no history.
 * With `since` (ms), only messages sent after that time are used, such as after a
 * conversation reset.
 */
export async function getPrivateHistory (event, maxMessages = 8, since = 0) {
  if (!event?.isPrivate || typeof event?.friend?.getChatHistory !== 'function') return []
  maxMessages = positiveInteger(maxMessages, 8)

  try {
    const messages = await event.friend.getChatHistory(event.message_seq ?? 0, maxMessages + 1, true)
    if (!Array.isArray(messages)) return []
    return messages
      .map((message, index) => toConversationMessage(message, event, index))
      .filter(Boolean)
      .filter(message => !since || timestampMs(message.order.time) > since)
      .sort(compareHistoryMessages)
      .slice(-maxMessages)
      .map(({ role, content }) => ({ role, content }))
  } catch {
    global.logger?.debug?.(`[pawpilot-plugin] private history recovery unavailable user=${event.user_id}`)
    return []
  }
}
