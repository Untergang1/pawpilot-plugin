import assert from 'node:assert/strict'
import test from 'node:test'
import { getGroupHistory } from '../lib/group-history.js'
import { formatGroupEvent } from '../lib/group-context.js'

test('group history keeps messages before the @Bot request in chronological order', async () => {
  let parameters
  const event = {
    isGroup: true,
    self_id: 'bot',
    group_id: 'group-1',
    message_id: 'current',
    message_seq: 20,
    group: {
      async getChatHistory (...args) {
        parameters = args
        return [
          { message_id: 'current', message_seq: 20, time: 40, user_id: 'third', message: 'current request' },
          { message_id: 'third', message_seq: 3, time: 30, user_id: 'third', sender: { nickname: 'Carol' }, message: 'third' },
          { message_id: 'second', message_seq: 2, time: 20, user_id: 'bot', sender: { card: 'Bot card' }, message: 'second' },
          { message_id: 'first', message_seq: 1, time: 10, user_id: 'first', sender: { card: 'Alice', nickname: 'ignored' }, message: 'first' }
        ]
      }
    }
  }

  const history = await getGroupHistory(event, 3, 4000)
  assert.deepEqual(parameters, [20, 4, true])
  assert.deepEqual(history.map(message => message.role), ['user', 'assistant', 'user'])
  assert.equal(history[0].senderName, 'Alice')
  assert.deepEqual((await getGroupHistory(event, 3, 4000, 20_000)).map(message => message.content), ['third'],
    'messages at or before a reset are skipped')
  assert.equal(history[0].participantName, 'member_first')
  assert.equal(history[1].senderName, 'Bot card')
  assert.equal(history[1].participantName, 'bot')
  assert.equal(history[2].senderName, 'Carol')
  assert.equal(history.some(message => message.content.includes('current request')), false)
})

test('group history formats message segments and retains a neutral boundary when truncated', async () => {
  const event = {
    isGroup: true,
    self_id: 'bot',
    group_id: 'group-1',
    message_seq: 9,
    group: {
      async getChatHistory () {
        return [{
          message_id: 'old',
          message_seq: 8,
          user_id: 'member',
          sender: { nickname: 'Member' },
          message: [{ type: 'text', text: 'x'.repeat(500) }, { type: 'image' }]
        }]
      }
    }
  }

  const [history] = await getGroupHistory(event, 8, 180)
  const formatted = formatGroupEvent(history, { maxChars: 180 })
  assert.ok(formatted.content.length <= 180)
  assert.match(formatted.content, /Background group message/)
  assert.match(formatted.content, /Member \(member\)/)
  assert.match(formatted.content, /truncated/)
})

test('group history preserves an explicit reply id without fetching its target', async () => {
  let historyCalls = 0
  const event = {
    isGroup: true,
    self_id: 'bot',
    group_id: 'group-1',
    message_seq: 10,
    group: {
      async getChatHistory () {
        historyCalls += 1
        return [{
          message_id: 'replying',
          message_seq: 9,
          user_id: 'member',
          message: [{ type: 'reply', id: 'target' }, { type: 'text', text: '我不同意' }]
        }]
      }
    }
  }
  const [history] = await getGroupHistory(event, 8, 4000)
  assert.equal(historyCalls, 1)
  assert.equal(history.reply.messageId, 'target')
  assert.equal(history.reply.available, false)
  assert.equal(history.content, '我不同意')
})

test('group history degrades to no context when the adapter cannot provide it', async () => {
  assert.deepEqual(await getGroupHistory({ isGroup: true }, 8, 4000), [])
  assert.deepEqual(await getGroupHistory({
    isGroup: true,
    group_id: 'group-1',
    group: { getChatHistory: async () => { throw new Error('unsupported') } }
  }, 8, 4000), [])
})
