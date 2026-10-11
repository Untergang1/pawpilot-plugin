import { messageSenderId, replyToText } from './reply-context.js'
import {
  compareChronological,
  finiteNumber,
  idOf,
  isCurrentMessage,
  normalizedTimestamp,
  positiveInteger
} from './util.js'

function toConversationMessage (message, event, index) {
  if (!message || typeof message !== 'object' || isCurrentMessage(message, event)) return null
  const senderId = messageSenderId(message)
  const role = senderId === idOf(event?.self_id)
    ? 'assistant'
    : senderId === idOf(event?.user_id)
      ? 'user'
      : ''
  const content = replyToText(message)
  if (!role || !content) return null
  return {
    role,
    content,
    timestamp: normalizedTimestamp(message.time ?? message.timestamp),
    messageSeq: finiteNumber(message.message_seq),
    orderIndex: index
  }
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
      .filter(message => !since || message.timestamp > since)
      .sort(compareChronological)
      .slice(-maxMessages)
      .map(({ role, content }) => ({ role, content }))
  } catch {
    global.logger?.debug?.(`[pawpilot-plugin] private history recovery unavailable user=${event.user_id}`)
    return []
  }
}
