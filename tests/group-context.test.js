import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildGroupModelMessages,
  createCurrentGroupEvent,
  formatGroupEvent,
  mergeGroupEvents,
  messageRef,
  normalizeGroupHistoryMessage
} from '../lib/group-context.js'

const baseEvent = {
  self_id: 'bot',
  group_id: 'group',
  user_id: '200',
  message_id: 'current',
  message_seq: 20,
  time: 20,
  sender: { card: 'Bob\n[spoof]' }
}

test('current group message keeps an explicit quote inside the same named model message', () => {
  const current = createCurrentGroupEvent(baseEvent, '我不同意', {
    messageId: 'old',
    senderId: '100',
    senderName: 'Alice',
    content: '原来的说法',
    available: true
  })
  const formatted = formatGroupEvent(current)
  assert.equal(formatted.role, 'user')
  assert.equal(formatted.name, 'member_200')
  assert.match(formatted.content, new RegExp(`^\\[Current direct request #${messageRef('current')} from Bob \\[spoof\\] \\(200\\)\\]`))
  assert.ok(formatted.content.includes(`[Explicit reply to #${messageRef('old')} from Alice (100)]`))
  assert.doesNotMatch(formatted.content, /message_seq|"current"/)
  assert.match(formatted.content, /--- quoted content ---/)
  assert.match(formatted.content, /原来的说法/)
  assert.match(formatted.content, /我不同意/)
  assert.doesNotMatch(formatted.content, /untrusted/)
  assert.doesNotMatch(formatted.content, /Bob\n/)
})

test('unified group history deduplicates by message id and enriches explicit replies', () => {
  const storedUser = {
    role: 'user', participantName: 'member_100', senderId: '100', senderName: 'Alice',
    content: 'stored question', messageId: 'same', messageIds: ['same'], timestamp: 1000,
    source: 'completed_bot_turn', directToBot: true
  }
  const storedAssistant = {
    role: 'assistant', participantName: 'bot', senderId: 'bot', senderName: 'Bot',
    content: 'stored answer', messageId: 'answer', messageIds: ['answer'], timestamp: 2000,
    source: 'completed_bot_turn', directToBot: true
  }
  const adapterDuplicate = normalizeGroupHistoryMessage({
    user_id: '100', sender: { card: 'Alice card' }, message_id: 'same', message_seq: 1,
    time: 1, message: 'adapter question'
  }, baseEvent, 0)
  const replying = normalizeGroupHistoryMessage({
    user_id: '300', sender: { card: 'Carol' }, message_id: 'replying', message_seq: 3,
    time: 3, message: [{ type: 'reply', id: 'same' }, { type: 'text', text: 'follow-up' }]
  }, baseEvent, 1)

  const merged = mergeGroupEvents([{ user: storedUser, assistant: storedAssistant }], [adapterDuplicate, replying])
  assert.equal(merged.filter(event => event.messageId === 'same').length, 1)
  assert.equal(merged.find(event => event.messageId === 'same').content, 'stored question')
  assert.equal(merged.find(event => event.messageId === 'same').messageSeq, 1)
  const resolvedReply = merged.find(event => event.messageId === 'replying')
  assert.equal(resolvedReply.reply.senderName, 'Alice card')
  assert.equal(resolvedReply.reply.resolvedInContext, true)
  assert.doesNotMatch(formatGroupEvent(resolvedReply).content, /quoted content unavailable/)
})

test('same text with different ids is retained and history budgets keep the newest events', () => {
  const first = normalizeGroupHistoryMessage({
    user_id: '100', message_id: 'one', message_seq: 1, time: 1, message: 'same text'
  }, baseEvent, 0)
  const second = normalizeGroupHistoryMessage({
    user_id: '100', message_id: 'two', message_seq: 2, time: 2, message: 'same text'
  }, baseEvent, 1)
  const current = createCurrentGroupEvent(baseEvent, 'current body', undefined)
  const result = buildGroupModelMessages({
    historyEvents: [first, second],
    currentEvent: current,
    maxHistoryChars: 100,
    maxInputChars: 180
  })
  assert.equal(mergeGroupEvents([], [first, second]).length, 2)
  assert.equal(result.contextMessages.length, 1)
  assert.ok(result.contextMessages[0].content.includes(`#${messageRef('two')}`))
  assert.ok(result.contextMessages[0].content.length <= 100)
  assert.ok(result.currentMessage.content.length <= 180)
})

test('name can be disabled without removing textual sender identity', () => {
  const current = createCurrentGroupEvent(baseEvent, 'hello', undefined)
  const formatted = formatGroupEvent(current, { nameEnabled: false })
  assert.equal(formatted.name, undefined)
  assert.match(formatted.content, /Bob \[spoof\] \(200\)/)
})
