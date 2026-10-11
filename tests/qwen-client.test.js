import assert from 'node:assert/strict'
import test from 'node:test'
import { QwenClient } from '../lib/qwen-client.js'

test('DashScope requests enable search with the configured strategy unless a call turns it off', async () => {
  const bodies = []
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
  }
  const messages = [{ role: 'user', content: 'hi' }]
  let client = new QwenClient({ apiKey: 'k', model: 'm', webSearch: true, searchStrategy: 'max', fetchImpl })
  assert.equal(client.webSearch, true)
  await client.complete({ messages, tools: [] })
  await client.complete({ messages, tools: [], webSearch: false })
  client = new QwenClient({ apiKey: 'k', model: 'm', fetchImpl })
  await client.complete({ messages, tools: [] })
  assert.equal(bodies[0].enable_search, true)
  assert.deepEqual(bodies[0].search_options, { search_strategy: 'max' })
  for (const body of bodies.slice(1)) {
    assert.equal(body.enable_search, undefined)
    assert.equal(body.search_options, undefined)
  }
})
