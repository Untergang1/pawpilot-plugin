export function segmentToText (segment) {
  if (typeof segment === 'string') return segment
  if (!segment || typeof segment !== 'object') return ''

  const data = segment.data && typeof segment.data === 'object' ? segment.data : segment
  switch (segment.type) {
    case 'text':
      return String(data.text ?? '')
    case 'at':
      return `@${data.qq ?? data.user_id ?? 'unknown'}`
    case 'image':
      return '[image]'
    case 'record':
    case 'audio':
      return '[audio]'
    case 'video':
      return '[video]'
    case 'file':
      return `[file: ${data.name ?? data.file ?? 'unknown'}]`
    case 'face':
      return `[emoji${data.name ? `: ${data.name}` : ''}]`
    case 'reply':
      return ''
    default:
      return `[${segment.type || 'message'}]`
  }
}

export function replyToText (reply) {
  if (!reply || typeof reply !== 'object') return ''
  if (Array.isArray(reply.message)) return reply.message.map(segmentToText).join('').trim()
  if (typeof reply.raw_message === 'string') return reply.raw_message.trim()
  if (typeof reply.message === 'string') return reply.message.trim()
  return ''
}

export async function getReplyText (event) {
  if (event?.reply_id == null || typeof event.getReply !== 'function') return ''
  try {
    return replyToText(await event.getReply())
  } catch {
    return ''
  }
}

function idOf (value) {
  return value == null ? '' : String(value)
}

export function messageSenderId (message) {
  return idOf(message?.user_id ?? message?.sender?.user_id ?? message?.sender?.qq)
}

export function messageSenderName (message, senderId = messageSenderId(message)) {
  const sender = message?.sender ?? {}
  const name = sender.card || sender.nickname || message?.sender_name || message?.nickname || message?.name
  return String(name || `用户 ${senderId || 'unknown'}`).trim()
}

export function explicitReplyId (message) {
  if (message?.reply_id != null) return idOf(message.reply_id)
  if (!Array.isArray(message?.message)) return ''
  const segment = message.message.find(item => item?.type === 'reply')
  if (!segment) return ''
  const data = segment.data && typeof segment.data === 'object' ? segment.data : segment
  return idOf(data.id ?? data.message_id ?? data.message_seq)
}

export async function getReplyContext (event) {
  const requestedId = idOf(event?.reply_id)
  if (!requestedId) return undefined
  if (typeof event?.getReply !== 'function') {
    return { messageId: requestedId, content: '', available: false }
  }
  try {
    const reply = await event.getReply()
    const senderId = messageSenderId(reply)
    const content = replyToText(reply)
    return {
      messageId: idOf(reply?.message_id) || requestedId,
      senderId,
      senderName: messageSenderName(reply, senderId),
      content,
      available: Boolean(content)
    }
  } catch {
    return { messageId: requestedId, content: '', available: false }
  }
}

export function buildUserMessage (userText, replyText, maxChars) {
  userText = typeof userText === 'string' ? userText.trim() : ''
  replyText = typeof replyText === 'string' ? replyText.trim() : ''
  if (!replyText) return userText

  const prefix = '--- quoted message ---\n'
  const suffix = `\n--- end quoted message ---${userText ? `\n\nUser's message:\n${userText}` : ''}`
  if (maxChars <= 0) return ''
  if (prefix.length + suffix.length > maxChars) return userText.slice(0, maxChars)
  const available = Math.max(0, maxChars - prefix.length - suffix.length)
  const truncationMarker = '\n[quoted message truncated]'
  const marker = truncationMarker.slice(0, available)
  const quoted = replyText.length > available
    ? `${replyText.slice(0, Math.max(0, available - marker.length))}${marker}`
    : replyText
  return `${prefix}${quoted}${suffix}`
}
