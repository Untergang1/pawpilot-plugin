import assert from 'node:assert/strict'
import test from 'node:test'
import { createCommandDispatcher } from '../lib/command-dispatcher.js'

test('command dispatcher forwards an allowed command through a cloned event', async () => {
  const event = { user_id: '10001', group_id: '20001', msg: '帮我扫码绑定' }
  const order = []
  event.reply = async (text, quote) => { order.push({ type: 'reply', text, quote }); return { message_id: 'pre' } }
  let dispatched
  const dispatchCommand = createCommandDispatcher({
    async dispatch (commandEvent) {
      order.push({ type: 'dispatch' })
      dispatched = commandEvent
    }
  })

  const result = await dispatchCommand({ command: '#phi bind qrcode', preface: '好的，我来帮你处理喵~' }, { event })
  assert.deepEqual(result, { ok: true, handled: true, reply: { text: '好的，我来帮你处理喵~', sendResult: { message_id: 'pre' } } })
  assert.notEqual(dispatched, event)
  assert.equal(dispatched.msg, '#phi bind qrcode')
  assert.equal(dispatched.user_id, '10001')
  assert.equal(dispatched.group_id, '20001')
  assert.equal(dispatched.aiCommandDispatch, true)
  assert.equal(event.msg, '帮我扫码绑定')
  assert.deepEqual(order, [
    { type: 'reply', text: '好的，我来帮你处理喵~', quote: true },
    { type: 'dispatch' }
  ])
})

test('command dispatcher forwards any well-formed single command', async () => {
  let dispatched
  const dispatchCommand = createCommandDispatcher({
    async dispatch (commandEvent) { dispatched = commandEvent }
  })

  const result = await dispatchCommand({ command: '#other status', preface: '我来看看喵~' }, {
    event: { reply: async () => {} }
  })
  assert.equal(result.handled, true)
  assert.equal(dispatched.msg, '#other status')
})

test('command dispatcher forwards commands with Chinese prefixes', async () => {
  let dispatched
  const dispatchCommand = createCommandDispatcher({
    async dispatch (commandEvent) { dispatched = commandEvent }
  })

  const result = await dispatchCommand({ command: '#王者帮助', preface: '好的，我来帮你看看喵~' }, {
    event: { reply: async () => {} }
  })
  assert.equal(result.handled, true)
  assert.equal(dispatched.msg, '#王者帮助')
})

test('command dispatcher accepts no multi-command input', async () => {
  const dispatchCommand = createCommandDispatcher()
  const result = await dispatchCommand({ command: '#phi help\n#phi update' }, { event: {} })
  assert.equal(result.code, 'INVALID_COMMAND')
})

test('command dispatcher does not dispatch when the preface cannot be sent', async () => {
  let dispatched = false
  const dispatchCommand = createCommandDispatcher({
    async dispatch () { dispatched = true }
  })

  await assert.rejects(
    dispatchCommand(
      { command: '#phi help', preface: '我来帮你看看喵~' },
      { event: { reply: async () => { throw new Error('reply failed') } } }
    ),
    /reply failed/
  )
  assert.equal(dispatched, false)
})

test('command dispatcher rejects an invalid preface before dispatching', async () => {
  let dispatched = false
  const dispatchCommand = createCommandDispatcher({
    async dispatch () { dispatched = true }
  })
  const result = await dispatchCommand(
    { command: '#phi help', preface: '第一句\n第二句' },
    { event: { reply: async () => {} } }
  )
  assert.equal(result.code, 'INVALID_PREFACE')
  assert.equal(dispatched, false)
})
