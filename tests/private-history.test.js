import assert from 'node:assert/strict'
import test from 'node:test'
import { getPrivateHistory } from '../lib/private-history.js'

test('private history excludes the current message, orders entries, and limits them', async () => {
  let call
  const event = {
    isPrivate: true,
    self_id: 'bot',
    user_id: 'user',
    message_id: 'current',
    message_seq: 99,
    friend: {
      async getChatHistory (...args) {
        call = args
        return [
          { message_id: 'current', user_id: 'user', message_seq: 99, time: 30, message: 'current request' },
          { message_id: '3', user_id: 'bot', message_seq: 3, time: 20, message: [{ type: 'text', text: 'bot reply' }] },
          { message_id: '2', user_id: 'user', message_seq: 2, time: 10, message: [{ type: 'text', text: 'hello' }] },
          { message_id: '1', user_id: 'user', message_seq: 1, time: 5, message: [{ type: 'image' }] },
          { message_id: 'other', user_id: 'other', message_seq: 4, time: 25, message: 'ignored' }
        ]
      }
    }
  }

  assert.deepEqual(await getPrivateHistory(event, 3), [
    { role: 'user', content: '[image]' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'bot reply' }
  ])
  assert.deepEqual(call, [99, 4, true])
  assert.deepEqual(await getPrivateHistory(event, 3, 15_000), [
    { role: 'assistant', content: 'bot reply' }
  ], 'messages at or before a reset are skipped')
})

test('private history gracefully degrades when unavailable or failing', async () => {
  assert.deepEqual(await getPrivateHistory({ isPrivate: true }, 8), [])
  assert.deepEqual(await getPrivateHistory({
    isPrivate: true,
    user_id: 'user',
    friend: { getChatHistory: async () => { throw new Error('unavailable') } }
  }, 8), [])
})
