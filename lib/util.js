/** Small dependency-free helpers shared across pawpilot-plugin modules. */

export function positiveInteger (value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

export function idOf (value) {
  return value == null ? '' : String(value)
}

export function isPlainObject (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function finiteNumber (value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/** Adapter timestamps may be in seconds or milliseconds; returns milliseconds. */
export function normalizedTimestamp (value, fallback = 0) {
  const number = finiteNumber(value)
  if (number == null || number <= 0) return fallback
  return number < 10_000_000_000 ? number * 1000 : number
}

/** Whether an adapter history entry is the message that triggered the current event. */
export function isCurrentMessage (message, event) {
  const messageId = idOf(message?.message_id)
  const eventMessageId = idOf(event?.message_id)
  if (messageId && eventMessageId) return messageId === eventMessageId
  const messageSeq = idOf(message?.message_seq)
  const eventMessageSeq = idOf(event?.message_seq)
  return Boolean(messageSeq && eventMessageSeq && messageSeq === eventMessageSeq)
}

/** Orders `{ timestamp, messageSeq, orderIndex }` entries by time, then sequence, then arrival. */
export function compareChronological (left, right) {
  if (left.timestamp && right.timestamp && left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
  if (left.messageSeq != null && right.messageSeq != null && left.messageSeq !== right.messageSeq) {
    return left.messageSeq - right.messageSeq
  }
  return (left.orderIndex ?? 0) - (right.orderIndex ?? 0)
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad2 = number => String(number).padStart(2, '0')

/** `MM-DD HH:mm` in the process time zone, stable for a given timestamp (ms). */
export function shortLocalTime (ms) {
  const date = new Date(ms)
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** `YYYY-MM-DD Ddd HH:mm UTC±hh:mm` in the process time zone. */
export function fullLocalTime (ms) {
  const date = new Date(ms)
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const zone = `UTC${sign}${pad2(Math.floor(Math.abs(offset) / 60))}:${pad2(Math.abs(offset) % 60)}`
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${WEEKDAYS[date.getDay()]} ${pad2(date.getHours())}:${pad2(date.getMinutes())} ${zone}`
}
