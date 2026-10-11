import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ChatGPTAuthError,
  ChatGPTCredentials,
  completeAuthorization,
  createAuthorization
} from '../lib/chatgpt-auth.js'
import { ChatGPTClient, buildResponsesRequest, toAssistantMessage } from '../lib/chatgpt-client.js'
import { ModelClientError } from '../lib/model-client.js'

function jwt (payload) {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part(payload)}.sig`
}

function credentialsFile (record = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawpilot-chatgpt-'))
  const file = path.join(dir, 'credentials.json')
  fs.writeFileSync(file, JSON.stringify({
    client_id: 'oaiapp_test',
    access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: 'refresh-1',
    ...record
  }))
  return file
}

function sse (events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function tokenResponse (body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

const tools = [{
  type: 'function',
  function: { name: 'read_status', description: 'Reads a status.', parameters: { type: 'object', properties: {} } }
}]

test('request conversion maps chat messages to Responses input items', () => {
  const body = buildResponsesRequest({
    model: 'gpt-test',
    reasoningEffort: 'low',
    tools,
    messages: [
      { role: 'system', content: 'RULES' },
      { role: 'user', name: 'u1', content: '查状态' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', function: { name: 'read_status', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_a', content: '{"ok":true}' },
      { role: 'assistant', content: '好了' }
    ]
  })
  assert.equal(body.instructions, 'RULES')
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.equal(body.temperature, undefined)
  assert.deepEqual(body.reasoning, { effort: 'low' })
  assert.deepEqual(body.tools[0], {
    type: 'function', name: 'read_status', description: 'Reads a status.', parameters: { type: 'object', properties: {} }, strict: false
  })
  assert.deepEqual(body.input, [
    { role: 'user', content: '查状态' },
    { type: 'function_call', call_id: 'call_a', name: 'read_status', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_a', output: '{"ok":true}' },
    { role: 'assistant', content: '好了' }
  ])
  assert.equal(buildResponsesRequest({ model: 'm', messages: [] }).tools, undefined)
})

test('request replays encrypted reasoning and forwards the prompt cache key', () => {
  const body = buildResponsesRequest({
    model: 'gpt-test',
    reasoningEffort: 'low',
    cacheKey: 'pawpilot-abc',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        reasoning_items: [{ summary: [], encrypted_content: 'enc' }],
        tool_calls: [{ id: 'call_a', function: { name: 'read_status', arguments: '{}' } }]
      }
    ]
  })
  assert.deepEqual(body.include, ['reasoning.encrypted_content'])
  assert.equal(body.prompt_cache_key, 'pawpilot-abc')
  assert.deepEqual(body.input.slice(1), [
    { type: 'reasoning', summary: [], encrypted_content: 'enc' },
    { type: 'function_call', call_id: 'call_a', name: 'read_status', arguments: '{}' }
  ])
  const plain = buildResponsesRequest({ model: 'm', messages: [] })
  assert.equal(plain.include, undefined)
  assert.equal(plain.prompt_cache_key, undefined)
})

test('tool-call replies keep encrypted reasoning items without their ids', () => {
  const message = toAssistantMessage([
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' },
    { type: 'function_call', call_id: 'call_x', name: 'read_status', arguments: '{}' }
  ])
  assert.deepEqual(message.reasoning_items, [{ summary: [], encrypted_content: 'enc' }])
  assert.equal(toAssistantMessage([{ type: 'reasoning', encrypted_content: 'enc' }]).reasoning_items, undefined)
})

test('client streams a function call and returns OpenAI-style tool calls', async () => {
  const seen = {}
  const fetchImpl = async (url, init) => {
    seen.url = url
    seen.headers = init.headers
    seen.body = JSON.parse(init.body)
    return new Response(sse([
      { type: 'response.created', response: { output: [] } },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_x', name: 'read_status', arguments: '{}' } },
      { type: 'response.completed', response: { output: [] } }
    ]))
  }
  const client = new ChatGPTClient({ credentialsFile: credentialsFile(), model: 'gpt-test', fetchImpl })
  const message = await client.complete({ messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }], tools })
  assert.equal(seen.url, 'https://api.openai.com/v1/responses')
  assert.match(seen.headers.Authorization, /^Bearer /)
  assert.equal(seen.body.model, 'gpt-test')
  assert.deepEqual(message, {
    content: null,
    tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'read_status', arguments: '{}' } }]
  })
})

test('client returns text replies and rejects incomplete streams', async () => {
  const reply = sse([
    { type: 'response.output_item.done', item: { type: 'reasoning', summary: [] } },
    { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: '你好' }] } },
    { type: 'response.completed', response: {} }
  ])
  let client = new ChatGPTClient({ credentialsFile: credentialsFile(), model: 'm', fetchImpl: async () => new Response(reply) })
  assert.deepEqual(await client.complete({ messages: [{ role: 'user', content: 'hi' }] }), { content: '你好' })

  const truncated = sse([{ type: 'response.created', response: {} }])
  const withUsage = sse([
    { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'ok' }] } },
    { type: 'response.completed', response: { usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 32 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 3 } } } }
  ])
  client = new ChatGPTClient({ credentialsFile: credentialsFile(), model: 'm', fetchImpl: async () => new Response(withUsage) })
  assert.deepEqual((await client.complete({ messages: [] })).usage,
    { inputTokens: 50, cachedTokens: 32, outputTokens: 7, reasoningTokens: 3 })

  client = new ChatGPTClient({ credentialsFile: credentialsFile(), model: 'm', fetchImpl: async () => new Response(truncated) })
  await assert.rejects(client.complete({ messages: [] }), error => error.code === 'STREAM_INTERRUPTED')
})

test('usage-limit failures map to USAGE_LIMIT', async () => {
  const failed = sse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }])
  let client = new ChatGPTClient({ credentialsFile: credentialsFile(), model: 'm', fetchImpl: async () => new Response(failed) })
  await assert.rejects(client.complete({ messages: [] }), error =>
    error instanceof ModelClientError && error.code === 'USAGE_LIMIT')

  const httpError = JSON.stringify({ error: { code: 'subscription_sharing_usage_unavailable' } })
  client = new ChatGPTClient({ credentialsFile: credentialsFile(), model: 'm', fetchImpl: async () => new Response(httpError, { status: 429 }) })
  await assert.rejects(client.complete({ messages: [] }), error => error.code === 'USAGE_LIMIT')
})

test('client refreshes once and retries after HTTP 401', async () => {
  const file = credentialsFile()
  const authorizations = []
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/oauth/token')) {
      return tokenResponse({ access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, n: 2 }), refresh_token: 'refresh-2', expires_in: 3600 })
    }
    authorizations.push(init.headers.Authorization)
    if (authorizations.length === 1) return new Response('{}', { status: 401 })
    return new Response(sse([{ type: 'response.completed', response: {} }]))
  }
  const client = new ChatGPTClient({ credentialsFile: file, model: 'm', fetchImpl })
  assert.deepEqual(await client.complete({ messages: [] }), { content: '' })
  assert.equal(authorizations.length, 2)
  assert.notEqual(authorizations[0], authorizations[1])
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).refresh_token, 'refresh-2')
})

test('client retries once after HTTP 5xx', async () => {
  let calls = 0
  let client = new ChatGPTClient({
    credentialsFile: credentialsFile(),
    model: 'm',
    fetchImpl: async () => ++calls === 1
      ? new Response('{}', { status: 502 })
      : new Response(sse([{ type: 'response.completed', response: {} }]))
  })
  assert.deepEqual(await client.complete({ messages: [] }), { content: '' })
  assert.equal(calls, 2)

  calls = 0
  client = new ChatGPTClient({
    credentialsFile: credentialsFile(),
    model: 'm',
    fetchImpl: async () => { calls += 1; return new Response('{}', { status: 503 }) }
  })
  await assert.rejects(client.complete({ messages: [] }), error =>
    error.code === 'SERVER_ERROR' && error.message.includes('HTTP 503'))
  assert.equal(calls, 2)
})

test('credentials refresh near expiry once for concurrent callers and persist the rotated token', async () => {
  const file = credentialsFile({ access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 60 }) })
  let refreshes = 0
  const fetchImpl = async (_url, init) => {
    refreshes += 1
    const params = new URLSearchParams(init.body)
    assert.equal(params.get('grant_type'), 'refresh_token')
    assert.equal(params.get('client_id'), 'oaiapp_test')
    assert.equal(params.get('resource'), 'https://api.openai.com/v1')
    return tokenResponse({ access_token: 'fresh', refresh_token: 'refresh-2', expires_in: 3600 })
  }
  const credentials = new ChatGPTCredentials({ file, fetchImpl })
  const tokens = await Promise.all([credentials.accessToken(), credentials.accessToken()])
  assert.deepEqual(tokens, ['fresh', 'fresh'])
  assert.equal(refreshes, 1)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.refresh_token, 'refresh-2')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('credentials report missing login and rejected refresh', async () => {
  const missing = new ChatGPTCredentials({ file: path.join(os.tmpdir(), 'pawpilot-missing', 'credentials.json') })
  await assert.rejects(missing.accessToken(), error => error instanceof ChatGPTAuthError && error.code === 'NOT_LOGGED_IN')

  const file = credentialsFile({ access_token: jwt({ exp: 0 }) })
  const rejected = new ChatGPTCredentials({ file, fetchImpl: async () => new Response('{"error":"invalid_grant"}', { status: 400 }) })
  await assert.rejects(rejected.accessToken(), error => error.code === 'REAUTH_REQUIRED')
})

test('authorization validates state and plan-usage scope', async () => {
  const authorization = createAuthorization({ redirectUri: 'http://127.0.0.1:1455/auth/callback' })
  const url = new URL(authorization.url)
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.match(url.searchParams.get('scope'), /chatgpt\.tokens\.use\.direct/)
  assert.match(url.searchParams.get('ext_agent_host_id'), /^urn:uuid:/)

  const callback = extra => new URLSearchParams({ code: 'c', state: authorization.state, client_id: 'oaiapp_new', ...extra })
  await assert.rejects(completeAuthorization(authorization, callback({ state: 'bad' })), error => error.code === 'STATE_MISMATCH')

  const noPlan = async () => tokenResponse({ access_token: 'a', scope: 'openid email' })
  await assert.rejects(completeAuthorization(authorization, callback(), { fetchImpl: noPlan }), error =>
    error.code === 'PLAN_USAGE_NOT_GRANTED')

  const granted = async (_url, init) => {
    const params = new URLSearchParams(init.body)
    assert.equal(params.get('code_verifier'), authorization.verifier)
    assert.equal(params.get('client_id'), 'oaiapp_new')
    return tokenResponse({
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3600,
      id_token: jwt({ sub: 'user-1', email: 'u@example.com', nonce: authorization.nonce }),
      scope: 'openid email offline_access resource.invoke chatgpt.tokens.use.direct'
    })
  }
  const record = await completeAuthorization(authorization, callback(), { fetchImpl: granted })
  assert.equal(record.client_id, 'oaiapp_new')
  assert.equal(record.ext_agent_host_id, authorization.hostId)
  assert.equal(record.subject, 'user-1')

  const reauth = createAuthorization({ redirectUri: 'http://127.0.0.1:1455/auth/callback', saved: record })
  assert.equal(new URL(reauth.url).searchParams.get('client_id'), 'oaiapp_new')
  assert.equal(new URL(reauth.url).searchParams.get('ext_agent_host_id'), record.ext_agent_host_id)
})
