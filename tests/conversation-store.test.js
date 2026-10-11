import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationStore } from '../lib/conversation-store.js'

const privateScope = { selfId: 'bot', userId: 'user' }

test('conversation history is isolated by private user and shared by group', () => {
  const store = new ConversationStore()
  store.appendExchange(privateScope, '你好', '你好！')
  assert.equal(store.getMessages(privateScope).length, 2)
  assert.equal(store.getMessages({ selfId: 'bot', userId: 'other' }).length, 0)

  const groupA = { selfId: 'bot', userId: 'first', groupId: 'group-a' }
  const groupAOtherMember = { selfId: 'bot', userId: 'second', groupId: 'group-a' }
  store.appendExchange(groupA, '用猫娘语气聊天', '好的。')
  assert.equal(store.getMessages(groupAOtherMember).length, 2)
})

test('conversation history expires and does not retain incomplete exchanges', async () => {
  const store = new ConversationStore({ ttlMs: 1 })
  store.appendExchange(privateScope, '你好', '你好！')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(store.getMessages(privateScope), [])
  store.appendExchange(privateScope, 'only user', '')
  assert.deepEqual(store.getMessages(privateScope), [])
})

test('conversation history trims whole oldest turns before truncating the newest turn', () => {
  const store = new ConversationStore({ maxTurns: 2, maxChars: 20 })
  store.appendExchange(privateScope, 'first', 'reply')
  store.appendExchange(privateScope, 'second', 'reply')
  store.appendExchange(privateScope, 'third', 'reply')
  const messages = store.getMessages(privateScope)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content, 'third')
})

test('recovered messages are retained before new exchanges and count toward the character budget', () => {
  const store = new ConversationStore({ maxChars: 12 })
  store.hydrateMessages(privateScope, [
    { role: 'user', content: 'older' },
    { role: 'assistant', content: 'recent' }
  ])
  store.appendExchange(privateScope, 'new', 'reply')
  assert.deepEqual(store.getMessages(privateScope), [
    { role: 'user', content: 'new' },
    { role: 'assistant', content: 'reply' }
  ])
})

test('recovered messages do not overwrite an existing conversation', () => {
  const store = new ConversationStore()
  store.appendExchange(privateScope, 'existing', 'answer')
  store.hydrateMessages(privateScope, [{ role: 'user', content: 'recovered' }])
  assert.deepEqual(store.getMessages(privateScope), [
    { role: 'user', content: 'existing' },
    { role: 'assistant', content: 'answer' }
  ])
})

test('group turns retain message metadata and are cloned on read', () => {
  const store = new ConversationStore()
  const scope = { selfId: 'bot', userId: 'first', groupId: 'group-a' }
  store.appendTurn(scope, {
    role: 'user',
    content: 'question',
    messageId: 'user-message',
    messageIds: ['user-message'],
    reply: { messageId: 'quoted', content: 'quoted text', available: true }
  }, {
    role: 'assistant',
    content: 'answer',
    messageId: 'bot-message',
    messageIds: ['bot-message']
  })
  const turns = store.getTurns({ selfId: 'bot', userId: 'other', groupId: 'group-a' })
  assert.equal(turns[0].user.reply.messageId, 'quoted')
  assert.equal(turns[0].assistant.messageId, 'bot-message')
  turns[0].user.reply.content = 'changed'
  assert.equal(store.getTurns(scope)[0].user.reply.content, 'quoted text')
})

test('trimming drops a chunk down to three quarters of the limits and queues it for summary', () => {
  const store = new ConversationStore({ maxTurns: 4 })
  for (const name of ['a', 'b', 'c', 'd', 'e']) store.appendExchange(privateScope, name, `${name}!`)
  assert.deepEqual(store.getMessages(privateScope).map(message => message.content), ['c', 'c!', 'd', 'd!', 'e', 'e!'])
  store.appendExchange(privateScope, 'f', 'f!')
  assert.equal(store.getMessages(privateScope).length, 8, 'no trim until the hard limit is exceeded again')

  const claim = store.takeDropped(privateScope)
  assert.deepEqual(claim.dropped, ['user: a', 'assistant: a!', 'user: b', 'assistant: b!'])
  assert.equal(store.takeDropped(privateScope), null, 'one summary at a time')
  store.finishSummary(claim, 'a and b were discussed')
  assert.equal(store.getSummary(privateScope), 'a and b were discussed')
})

test('a failed summary requeues the dropped text', () => {
  const store = new ConversationStore({ maxTurns: 1 })
  store.appendExchange(privateScope, 'a', 'a!')
  store.appendExchange(privateScope, 'b', 'b!')
  const claim = store.takeDropped(privateScope)
  store.finishSummary(claim, null)
  assert.deepEqual(store.takeDropped(privateScope).dropped, ['user: a', 'assistant: a!'])
  assert.equal(store.getSummary(privateScope), '')
})

test('reset clears history and summary and records the reset time', () => {
  const store = new ConversationStore()
  assert.equal(store.getResetAt(privateScope), 0)
  store.appendExchange(privateScope, 'a', 'a!')
  const before = Date.now()
  store.reset(privateScope)
  assert.deepEqual(store.getMessages(privateScope), [])
  assert.ok(store.getResetAt(privateScope) >= before)
  assert.equal(store.getResetAt({ selfId: 'bot', userId: 'other' }), 0)
})
