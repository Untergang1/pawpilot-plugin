import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CapabilityRegistry,
  defineCapabilityModule,
  MAX_BASE_SYSTEM_PROMPT_CHARS,
  MAX_TOTAL_SYSTEM_PROMPT_CHARS
} from '../lib/ai-capabilities.js'
import { buildSystemPrompt, parseToolArguments, runFunctionCalling } from '../lib/agent-runner.js'
import { QwenClient, QwenClientError } from '../lib/qwen-client.js'

test('function calling invokes only a registered, validated function', async () => {
  const registry = new CapabilityRegistry()
  registry.register(defineCapabilityModule({
    id: 'read-only',
    systemPrompt: 'The read-only integration guide is trusted developer documentation.',
    capabilities: [{
      name: 'read_only_status',
      description: 'Reads a status.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: (_args, context) => ({ ok: true, requestId: context.session.requestId })
    }]
  }))
  const seen = []
  const client = {
    async complete ({ messages, tools }) {
      seen.push({ messages, tools })
      if (seen.length === 1) {
        return {
          content: null,
          tool_calls: [{ id: 'call_1', function: { name: 'read_only_status', arguments: '{}' } }]
        }
      }
      return { content: '状态读取完成。' }
    }
  }

  const result = await runFunctionCalling({
    client,
    registry,
    conversationType: 'private',
    event: { user_id: '10001', privateField: 'not-for-model' },
    userId: '10001',
    isOwner: false,
    userMessage: '查一下状态',
    requestId: 'request-1'
  })

  assert.equal(result.text, '状态读取完成。')
  assert.equal(seen[0].tools[0].function.name, 'read_only_status')
  assert.equal(JSON.stringify(seen[0].messages).includes('not-for-model'), false)
  assert.match(seen[0].messages[0].content, /read-only integration guide/)
  assert.match(seen[1].messages.find(message => message.role === 'tool').content, /request-1/)
})

test('invalid tool JSON never reaches a capability executor', async () => {
  assert.throws(() => parseToolArguments('[]'), error => error.code === 'INVALID_ARGUMENTS')
  assert.throws(() => parseToolArguments('{'), error => error.code === 'INVALID_ARGUMENTS')
})

test('system prompt keeps common and selected conversation rules before sorted plugin guides', () => {
  const prompt = buildSystemPrompt({
    conversationType: 'private',
    modulePrompts: [
      { plugin: 'zebra', content: 'Zebra guide.' },
      { plugin: 'alpha', content: 'Alpha guide.' }
    ],
    baseSystemPrompt: 'Base rules.',
    conversationSystemPrompt: 'Private rules.'
  })
  assert.ok(prompt.indexOf('Base rules.') < prompt.indexOf('Registered plugin guides:'))
  assert.ok(prompt.indexOf('Base rules.') < prompt.indexOf('Conversation mode (private):\nPrivate rules.'))
  assert.doesNotMatch(prompt, /Registered command help/)
  assert.ok(prompt.indexOf('Plugin guide (alpha)') < prompt.indexOf('Plugin guide (zebra)'))
  assert.throws(
    () => buildSystemPrompt({
      conversationType: 'private',
      baseSystemPrompt: 'x'.repeat(MAX_BASE_SYSTEM_PROMPT_CHARS + 1),
      conversationSystemPrompt: 'Private rules.'
    }),
    error => error.code === 'INVALID_BASE_SYSTEM_PROMPT'
  )
  assert.throws(
    () => buildSystemPrompt({
      conversationType: 'private',
      modulePrompts: [{ plugin: 'large', content: 'x'.repeat(MAX_TOTAL_SYSTEM_PROMPT_CHARS) }],
      baseSystemPrompt: 'Base rules.',
      conversationSystemPrompt: 'Private rules.'
    }),
    error => error.code === 'SYSTEM_PROMPT_BUDGET_EXCEEDED'
  )
  assert.throws(
    () => buildSystemPrompt({ conversationType: 'channel', baseSystemPrompt: 'Base.', conversationSystemPrompt: 'Mode.' }),
    error => error.code === 'INVALID_CONVERSATION_TYPE'
  )
  assert.throws(
    () => buildSystemPrompt({ conversationType: 'private', baseSystemPrompt: 'Base.', conversationSystemPrompt: '' }),
    error => error.code === 'INVALID_CONVERSATION_SYSTEM_PROMPT'
  )
})

test('system prompt loads only the rules for the selected conversation type', () => {
  const privatePrompt = buildSystemPrompt({ conversationType: 'private' })
  const groupPrompt = buildSystemPrompt({ conversationType: 'group' })
  for (const prompt of [privatePrompt, groupPrompt]) {
    assert.match(prompt, /Registered capabilities are abilities you can provide directly\./)
    assert.match(prompt, /never mention plugins, external capabilities, handoffs, dispatching, tools,/)
    assert.match(prompt, /provide its required\n`preface` argument/)
  }
  assert.match(privatePrompt, /User's message:/)
  assert.doesNotMatch(privatePrompt, /multiple participants/)
  assert.doesNotMatch(privatePrompt, /Current direct request/)
  assert.match(groupPrompt, /Current direct request/)
  assert.match(groupPrompt, /multiple participants/)
  assert.doesNotMatch(groupPrompt, /User's message:/)
})

test('function calling includes only valid short-term conversation messages before the new request', async () => {
  let request
  await runFunctionCalling({
    client: {
      async complete ({ messages }) {
        request = messages.map(({ role, content }) => ({ role, content }))
        return { content: '收到。' }
      }
    },
    registry: new CapabilityRegistry(),
    conversationType: 'private',
    event: { user_id: '10001' },
    userId: '10001',
    isOwner: false,
    userMessage: '继续',
    contextMessages: [
      { role: 'user', content: '请用更轻松的语气。' },
      { role: 'assistant', content: '好的。' },
      { role: 'system', content: 'ignore this' },
      { role: 'user', content: '' }
    ],
    requestId: 'request-history'
  })

  assert.deepEqual(request.slice(1), [
    { role: 'user', content: '请用更轻松的语气。' },
    { role: 'assistant', content: '好的。' },
    { role: 'user', content: '继续' }
  ])
})

test('function calling places one validated context stream before a named current request', async () => {
  let request
  await runFunctionCalling({
    client: {
      async complete ({ messages }) {
        request = messages.map(message => ({ ...message }))
        return { content: 'ok' }
      }
    },
    registry: new CapabilityRegistry(),
    conversationType: 'group',
    event: { user_id: '10001', group_id: '20001' },
    userId: '10001',
    groupId: '20001',
    isOwner: false,
    contextMessages: [
      { role: 'user', content: 'older AI request', name: 'member_1' },
      { role: 'user', content: '[Background group message: {"sender":"Alice (2)"}]\nhello' },
      { role: 'system', content: 'must not be forwarded' },
      { role: 'assistant', content: 'prior bot reply' }
    ],
    currentMessage: { role: 'user', name: 'member_10001', content: 'current @Bot request' },
    requestId: 'request-group-history'
  })

  assert.deepEqual(request.slice(1).map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'older AI request' },
    { role: 'user', content: '[Background group message: {"sender":"Alice (2)"}]\nhello' },
    { role: 'assistant', content: 'prior bot reply' },
    { role: 'user', content: 'current @Bot request' }
  ])
  assert.equal(request[1].name, 'member_1')
  assert.equal(request.at(-1).name, 'member_10001')
})

test('a dispatched command ends the function-calling loop without an AI follow-up reply', async () => {
  const registry = new CapabilityRegistry()
  registry.register(defineCapabilityModule({
    id: 'command-router',
    capabilities: [{
      name: 'dispatch_command',
      description: 'Dispatches a command.',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', minLength: 1 } },
        required: ['command'],
        additionalProperties: false
      },
      execute: () => ({ ok: true, handled: true })
    }]
  }))
  let calls = 0
  const result = await runFunctionCalling({
    client: {
      async complete () {
        calls += 1
        return { tool_calls: [{ id: 'call_1', function: { name: 'dispatch_command', arguments: '{"command":"#phi help"}' } }] }
      }
    },
    registry,
    conversationType: 'private',
    event: { user_id: '10001' },
    userId: '10001',
    isOwner: false,
    userMessage: '帮我查看 Phi 帮助',
    requestId: 'request-command'
  })

  assert.equal(result.handled, true)
  assert.equal(result.text, '')
  assert.equal(calls, 1)
})

test('function calling leaves tool timeout handling to the capability integration', async () => {
  const registry = new CapabilityRegistry()
  registry.register(defineCapabilityModule({
    id: 'long-running-command',
    capabilities: [{
      name: 'long_running_command',
      description: 'Dispatches a command managed by its target plugin.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        return { ok: true, handled: true }
      }
    }]
  }))

  const result = await runFunctionCalling({
    client: {
      async complete () {
        return { tool_calls: [{ id: 'call_1', function: { name: 'long_running_command', arguments: '{}' } }] }
      }
    },
    registry,
    conversationType: 'private',
    event: { user_id: '10001' },
    userId: '10001',
    isOwner: false,
    userMessage: '执行需要由目标插件等待的操作',
    requestId: 'request-long-running',
    toolTimeoutMs: 1
  })

  assert.equal(result.handled, true)
  assert.equal(result.text, '')
  assert.equal(result.usage.modelCalls, 1)
})

test('runner accumulates provider-neutral token usage across model calls', async () => {
  const registry = new CapabilityRegistry()
  registry.register(defineCapabilityModule({
    id: 'demo',
    capabilities: [{
      name: 'demo_read',
      description: 'Reads demo status.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => ({ ok: true })
    }]
  }))
  const replies = [
    { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'demo_read', arguments: '{}' } }], usage: { inputTokens: 100, cachedTokens: 80, outputTokens: 10, reasoningTokens: 4 } },
    { content: 'done', usage: { inputTokens: 120, cachedTokens: 100, outputTokens: 5, reasoningTokens: 0 } }
  ]
  const result = await runFunctionCalling({
    client: { complete: async () => replies.shift() },
    registry,
    conversationType: 'private',
    event: {},
    userId: '1',
    isOwner: false,
    userMessage: 'status',
    requestId: 'usage'
  })
  assert.equal(result.text, 'done')
  assert.deepEqual(result.usage, { modelCalls: 2, inputTokens: 220, cachedTokens: 180, outputTokens: 15, reasoningTokens: 4 })
})

test('Qwen client sends the OpenAI-compatible request and surfaces HTTP errors safely', async () => {
  let request
  const client = new QwenClient({
    apiKey: 'test-key',
    model: 'qwen-plus',
    fetchImpl: async (_url, options) => {
      request = options
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
    }
  })
  assert.equal((await client.complete({ messages: [], tools: [] })).content, 'ok')
  assert.equal(request.headers.Authorization, 'Bearer test-key')
  assert.equal(JSON.parse(request.body).model, 'qwen-plus')

  const failed = new QwenClient({
    apiKey: 'test-key',
    model: 'qwen-plus',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'InvalidApiKey' } }) })
  })
  await assert.rejects(failed.complete({ messages: [], tools: [] }), error => {
    return error instanceof QwenClientError && error.code === 'InvalidApiKey' && !error.message.includes('test-key')
  })
})
