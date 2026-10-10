import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexClient, CodexClientError, buildTranscript, parseCodexOutput } from '../lib/codex-client.js'

function createCodexHome () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawpilot-codex-home-'))
  fs.writeFileSync(path.join(home, 'auth.json'), '{}')
  return home
}

function fakeSdk (run) {
  const seen = {}
  class Codex {
    constructor (options) {
      seen.options = options
      seen.instructions = fs.readFileSync(options.config.model_instructions_file, 'utf8')
    }

    startThread (threadOptions) {
      seen.threadOptions = threadOptions
      return { run: (input, turnOptions) => run(input, turnOptions, seen) }
    }
  }
  return { seen, loadSdk: async () => ({ Codex }) }
}

const tools = [{
  type: 'function',
  function: { name: 'read_status', description: 'Reads a status.', parameters: { type: 'object', properties: {} } }
}]

test('codex client sends system prompt as instructions and converts tool calls', async () => {
  const { seen, loadSdk } = fakeSdk(async (input, turnOptions) => {
    seen.input = input
    seen.turnOptions = turnOptions
    return { finalResponse: JSON.stringify({ reply: '', tool_calls: [{ name: 'read_status', arguments: '{}' }] }) }
  })
  process.env.CODEX_API_KEY = 'must-not-leak'
  const client = new CodexClient({ codexHome: createCodexHome(), reasoningEffort: 'low', loadSdk })
  const message = await client.complete({
    messages: [
      { role: 'system', content: 'SYSTEM RULES' },
      { role: 'user', name: 'u1', content: '查状态' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', function: { name: 'read_status', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_a', content: '{"ok":true}' }
    ],
    tools
  })
  delete process.env.CODEX_API_KEY

  assert.match(seen.instructions, /SYSTEM RULES/)
  assert.match(seen.instructions, /"name":"read_status"/)
  assert.doesNotMatch(seen.input, /SYSTEM RULES/)
  assert.match(seen.input, /\[user name=u1\]\n查状态/)
  assert.match(seen.input, /\[function result id=call_a\]\n\{"ok":true\}/)
  assert.ok(seen.turnOptions.outputSchema)
  assert.equal(seen.options.env.CODEX_API_KEY, undefined)
  assert.equal(seen.options.config.default_permissions, 'pawpilot')
  assert.equal(seen.threadOptions.sandboxMode, undefined)
  assert.equal(seen.threadOptions.modelReasoningEffort, 'low')
  assert.equal(fs.existsSync(seen.options.config.model_instructions_file), false)
  assert.equal(message.content, null)
  assert.equal(message.tool_calls[0].function.name, 'read_status')
  assert.equal(message.tool_calls[0].function.arguments, '{}')
})

test('codex output without tool calls becomes a plain reply', () => {
  assert.deepEqual(parseCodexOutput('{"reply":"你好","tool_calls":[]}'), { content: '你好' })
  assert.throws(() => parseCodexOutput('你好'), error => error.code === 'INVALID_RESPONSE')
  assert.throws(() => parseCodexOutput('{"reply":1}'), error => error.code === 'INVALID_RESPONSE')
})

test('transcript excludes system messages', () => {
  const transcript = buildTranscript([{ role: 'system', content: 'secret' }, { role: 'user', content: 'hi' }])
  assert.doesNotMatch(transcript, /secret/)
  assert.match(transcript, /\[user\]\nhi/)
})

test('codex client requires a logged-in CODEX_HOME', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawpilot-codex-empty-'))
  const client = new CodexClient({ codexHome: home, loadSdk: async () => assert.fail('SDK must not load') })
  await assert.rejects(client.complete({ messages: [], tools: [] }), error =>
    error instanceof CodexClientError && error.code === 'CODEX_NOT_LOGGED_IN')
})

test('codex client maps aborted turns to a timeout', async () => {
  const { loadSdk } = fakeSdk((_input, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')))
  }))
  const client = new CodexClient({ codexHome: createCodexHome(), timeoutMs: 10, loadSdk })
  await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] }), error =>
    error.code === 'REQUEST_TIMEOUT')
})
