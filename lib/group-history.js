import {
  normalizeGroupHistoryMessage,
  trimGroupEventCandidates
} from './group-context.js'
import { compareChronological, isCurrentMessage, positiveInteger } from './util.js'

/**
 * Best-effort adapter history snapshot preceding the current group request. With
 * `since` (ms), only messages sent after that time are used.
 */
export async function getGroupHistory (event, maxMessages = 64, maxChars = 6000, since = 0) {
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
      .filter(item => !since || item.timestamp > since)
      .sort(compareChronological)
      .slice(-maxMessages)
    return trimGroupEventCandidates(events, maxChars)
  } catch {
    global.logger?.debug?.(`[pawpilot-plugin] group history recovery unavailable group=${event.group_id}`)
    return []
  }
}
