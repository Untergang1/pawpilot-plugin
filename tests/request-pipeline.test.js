import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../lib/config.js'
import { MESSAGES } from '../lib/messages.js'
import { ModelClientError } from '../lib/model-client.js'
import { createRequestPipeline } from '../lib/request-pipeline.js'

const NOW = new Date(2026, 9, 11, 14, 5).getTime()
const TIME_LINE = /^\[Current time: 2026-10-11 Sun 14:05 UTC[+-]\d{2}:\d{2}\]\n/
const settle = () => new Promise(resolve => setImmediate(resolve))

function privateEvent (msg, extra = {}) {
  return { isPrivate: true, self_id: 'bot', user_id: 'u1', message_id: `m-${msg}`, msg, ...extra }
}

function groupEvent (msg, extra = {}) {
  return {
    isGroup: true,
    atBot: true,
    self_id: 'bot',
    group_id: 'g1',
    user_id: 'u1',
    message_id: `m-${msg}`,
    sender: { card: 'Alice' },
    msg,
    ...extra
  }
}

function setup ({ runner, config = {}, client = {}, sendResult = { message_id: 'sent' } } = {}) {
  const calls = []
  const replies = []
  const pipeline = createRequestPipeline({
    getRegistry: async () => ({}),
    isOwner: () => false,
    createClient: () => client,
    now: () => NOW,
    runner: async args => {
      calls.push(args)
      return runner ? runner(args) : { text: `reply ${calls.length}` }
    }
  })
  const reply = async text => {
    replies.push(text)
    return typeof sendResult === 'function' ? sendResult(text) : sendResult
  }
  return {
    pipeline,
    calls,
    replies,
    handle: event => pipeline.handle(event, normalizeConfig({ conversationHistoryRecoveryEnabled: false, groupHistoryRecoveryEnabled: false, ...config }), reply)
  }
}

test('events that are not for the agent are ignored', async () => {
  const { handle, calls, replies } = setup()
  assert.equal(await handle(privateEvent('#phi b30')), false)
  assert.equal(await handle(privateEvent('/help')), false)
  assert.equal(await handle(privateEvent('／help')), false)
  assert.equal(await handle(groupEvent('hi', { atBot: false })), false)
  assert.equal(await handle(privateEvent('hi', { user_id: 'bot' })), false)
  const disabled = setup({ config: { enabled: false } })
  assert.equal(await disabled.handle(privateEvent('hi')), false)
  assert.equal(calls.length + replies.length, 0)
})

test('private replies are remembered only after a successful send', async () => {
  let ok = false
  const { handle, calls, replies } = setup({ sendResult: () => ok ? { message_id: 'sent' } : false })
  await handle(privateEvent('first'))
  assert.equal(calls[0].currentMessage.role, 'user')
  assert.match(calls[0].currentMessage.content, new RegExp(`${TIME_LINE.source}first$`))
  assert.equal(calls[0].conversationType, 'private')
  assert.match(calls[0].cacheKey, /^pawpilot-[0-9a-f]{32}$/)

  ok = true
  await handle(privateEvent('second'))
  assert.deepEqual(calls[1].contextMessages, [], 'the failed send was not stored')
  await handle(privateEvent('third'))
  assert.deepEqual(calls[2].contextMessages, [
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'reply 2' }
  ])
  assert.deepEqual(replies, ['reply 1', 'reply 2', 'reply 3'])
})

test('over-long input is rejected before calling the model', async () => {
  const { handle, calls, replies } = setup({ config: { maxInputChars: 5 } })
  await handle(privateEvent('123456'))
  assert.equal(calls.length, 0)
  assert.deepEqual(replies, [MESSAGES.inputTooLong(5)])
})

test('a second private request while one is running is refused as busy', async () => {
  let release
  const { handle, replies } = setup({ runner: () => new Promise(resolve => { release = () => resolve({ text: 'done' }) }) })
  const first = handle(privateEvent('slow'))
  await settle()
  await handle(privateEvent('again'))
  assert.deepEqual(replies, [MESSAGES.privateBusy])
  release()
  await first
  assert.deepEqual(replies, [MESSAGES.privateBusy, 'done'])
})

test('handled tool results send nothing more and store only the sent preface', async () => {
  const { handle, calls, replies } = setup({
    runner: args => args.currentMessage.content.endsWith('run a command')
      ? { text: '', handled: true, reply: { text: '猫猫这就去查喵~', sendResult: { message_id: 'pre' } } }
      : { text: 'ok' }
  })
  assert.equal(await handle(privateEvent('run a command')), true)
  assert.deepEqual(replies, [])
  await handle(privateEvent('next'))
  assert.deepEqual(calls[1].contextMessages, [
    { role: 'user', content: 'run a command' },
    { role: 'assistant', content: '猫猫这就去查喵~' }
  ])
})

test('handled tool results without a sent preface are not stored', async () => {
  const { handle, calls } = setup({
    runner: args => args.currentMessage.content.endsWith('run a command')
      ? { text: '', handled: true, reply: { text: '猫猫这就去查喵~', sendResult: false } }
      : { text: 'ok' }
  })
  await handle(privateEvent('run a command'))
  await handle(privateEvent('next'))
  assert.deepEqual(calls[1].contextMessages, [])
})

test('model errors become the matching public message', async () => {
  const { handle, replies } = setup({
    runner: () => { throw new ModelClientError('quota', 'USAGE_LIMIT', { provider: 'chatgpt' }) }
  })
  await handle(privateEvent('hi'))
  assert.deepEqual(replies, [MESSAGES.error.usageLimit])
})

test('group requests use labelled group context and store completed turns for the whole group', async () => {
  const { handle, calls } = setup()
  await handle(groupEvent('hello'))
  assert.equal(calls[0].conversationType, 'group')
  assert.equal(calls[0].groupId, 'g1')
  assert.match(calls[0].currentMessage.content, new RegExp(`${TIME_LINE.source}\\[Current direct request #\\w{6} at \\d{2}-\\d{2} \\d{2}:\\d{2} from Alice \\(u1\\)\\]\\nhello$`))

  await handle(groupEvent('more', { user_id: 'u2', sender: { card: 'Bob' } }))
  assert.deepEqual(calls[1].contextMessages.map(message => message.role), ['user', 'assistant'])
  assert.match(calls[1].contextMessages[0].content, /Completed direct interaction .*Alice/)
})

test('dropped turns are summarized after the reply and sent as the first context message', async () => {
  const summaries = []
  const client = {
    async complete ({ messages }) {
      summaries.push(messages[1].content)
      return { content: 'they said a and b' }
    }
  }
  const { handle, calls } = setup({ client, config: { conversationHistoryTurns: 2 } })
  for (const text of ['a', 'b', 'c']) await handle(privateEvent(text))
  await settle()
  assert.equal(summaries.length, 1)
  assert.match(summaries[0], /user: a\nassistant: reply 1/)

  await handle(privateEvent('d'))
  assert.deepEqual(calls[3].contextMessages[0], { role: 'user', content: '[Earlier conversation summary]\nthey said a and b' })
})

test('reset clears the conversation and summary for that scope only', async () => {
  const { handle, calls, pipeline } = setup()
  await handle(privateEvent('a'))
  await handle(groupEvent('g'))
  assert.equal(pipeline.reset(privateEvent('#ai 重置')), MESSAGES.resetPrivate)
  await handle(privateEvent('b'))
  assert.deepEqual(calls[2].contextMessages, [])
  await handle(groupEvent('h'))
  assert.equal(calls[3].contextMessages.length, 2, 'the group conversation is untouched')
  assert.equal(pipeline.reset(groupEvent('#ai 重置')), MESSAGES.resetGroup)
})
