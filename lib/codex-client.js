import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PERMISSION_PROFILE = 'pawpilot'
// The Codex agent must act purely as a reasoning backend: deny all filesystem
// access so its built-in shell and patch tools cannot run. Passing sandboxMode
// would override this profile, so the thread options intentionally omit it.
const PERMISSION_OVERRIDE = `permissions.${PERMISSION_PROFILE}.filesystem={":root"="deny"}`
// Turn off agent features whose tool schemas and injected instructions the bot never
// uses; together they roughly double the input tokens of every turn. The
// multi-agent role prompt is chosen by the model catalog and cannot be disabled.
const LEAN_CONFIG = Object.freeze({
  features: {
    multi_agent: false,
    plugins: false,
    apps: false,
    image_generation: false,
    view_image: false,
    shell_tool: false,
    unified_exec: false,
    skill_search: false,
    browser_use: false,
    computer_use: false,
    goals: false,
    shell_snapshot: false
  },
  skills: { include_instructions: false, bundled: { enabled: false } },
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  include_environment_context: false
})
// Strip API keys so the CLI authenticates with the ChatGPT login stored in CODEX_HOME.
const STRIPPED_ENV_KEYS = ['OPENAI_API_KEY', 'CODEX_API_KEY']

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    reply: { type: 'string' },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          arguments: { type: 'string' }
        },
        required: ['name', 'arguments'],
        additionalProperties: false
      }
    }
  },
  required: ['reply', 'tool_calls'],
  additionalProperties: false
})

const OUTPUT_PROTOCOL = [
  'Output protocol:',
  'You are the reasoning backend of a chat bot. You have no shell, file, network or agent tools; never try to use them.',
  'The only actions available are the functions listed below. Respond with one JSON object matching the output schema:',
  '- To answer the user, put the final reply text in "reply" and use an empty "tool_calls" array.',
  '- To call functions, list them in "tool_calls"; each "arguments" is a JSON object serialized as a string that satisfies the function parameters. Leave "reply" empty.',
  'Function results are returned to you in a later turn of the conversation transcript.'
].join('\n')

export class CodexClientError extends Error {
  constructor (message, code = 'CODEX_REQUEST_FAILED') {
    super(message)
    this.name = 'CodexClientError'
    this.code = code
  }
}

function expandHome (dir) {
  return dir === '~' || dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(1)) : dir
}

function buildInstructions (messages, tools) {
  const system = messages
    .filter(message => message.role === 'system' && typeof message.content === 'string')
    .map(message => message.content)
    .join('\n\n')
  const functions = tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  }))
  return [
    system,
    OUTPUT_PROTOCOL,
    `Available functions (JSON):\n${functions.length ? JSON.stringify(functions) : 'none'}`
  ].join('\n\n')
}

function formatMessage (message) {
  if (message.role === 'tool') {
    return `[function result id=${message.tool_call_id}]\n${message.content}`
  }
  if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    const calls = message.tool_calls.map(call => ({
      id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments
    }))
    const text = message.content ? `${message.content}\n` : ''
    return `[assistant function calls]\n${text}${JSON.stringify(calls)}`
  }
  const name = message.name ? ` name=${message.name}` : ''
  return `[${message.role}${name}]\n${message.content ?? ''}`
}

/** Serializes the non-system conversation into a single transcript prompt. */
export function buildTranscript (messages) {
  const body = messages
    .filter(message => message.role !== 'system')
    .map(formatMessage)
    .join('\n\n')
  return [
    'Conversation transcript (oldest first). Produce the next assistant output for it.',
    '<transcript>',
    body,
    '</transcript>'
  ].join('\n')
}

/** Converts the structured Codex output into an OpenAI-style assistant message. */
export function parseCodexOutput (finalResponse) {
  let output
  try {
    output = JSON.parse(finalResponse)
  } catch {
    throw new CodexClientError('Codex returned a non-JSON response', 'INVALID_RESPONSE')
  }
  if (output === null || typeof output !== 'object' || typeof output.reply !== 'string' ||
      !Array.isArray(output.tool_calls)) {
    throw new CodexClientError('Codex response does not match the output schema', 'INVALID_RESPONSE')
  }
  const calls = output.tool_calls.filter(call =>
    typeof call?.name === 'string' && typeof call.arguments === 'string')
  if (!calls.length) return { content: output.reply }
  return {
    content: output.reply || null,
    tool_calls: calls.map(call => ({
      id: `call_${crypto.randomUUID()}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments }
    }))
  }
}

/**
 * Model client backed by the Codex SDK, using the ChatGPT subscription login in a
 * dedicated CODEX_HOME. Each completion is one stateless Codex turn whose
 * structured output emulates OpenAI function calling.
 */
export class CodexClient {
  constructor ({
    codexHome = '~/.codex-pawpilot',
    model,
    reasoningEffort = 'low',
    timeoutMs = 120_000,
    loadSdk = () => import('@openai/codex-sdk')
  } = {}) {
    this.codexHome = expandHome(codexHome)
    this.model = model || undefined
    this.reasoningEffort = reasoningEffort
    this.timeoutMs = timeoutMs
    this.loadSdk = loadSdk
  }

  #workDir () {
    // An empty private directory; the permission profile denies reading it anyway.
    CodexClient.workDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'pawpilot-codex-'))
    return CodexClient.workDir
  }

  async complete ({ messages, tools = [], signal }) {
    if (!fs.existsSync(path.join(this.codexHome, 'auth.json'))) {
      throw new CodexClientError('Codex is not logged in for the configured CODEX_HOME', 'CODEX_NOT_LOGGED_IN')
    }
    const { Codex } = await this.loadSdk()
    const workDir = this.#workDir()
    const instructionsFile = path.join(workDir, `instructions-${crypto.randomUUID()}.md`)
    fs.writeFileSync(instructionsFile, buildInstructions(messages, tools), { mode: 0o600 })

    const env = { ...process.env, CODEX_HOME: this.codexHome }
    for (const key of STRIPPED_ENV_KEYS) delete env[key]
    const codex = new Codex({
      env,
      config: {
        ...LEAN_CONFIG,
        default_permissions: PERMISSION_PROFILE,
        model_instructions_file: instructionsFile
      },
      configOverrides: [PERMISSION_OVERRIDE]
    })
    const thread = codex.startThread({
      model: this.model,
      workingDirectory: workDir,
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      modelReasoningEffort: this.reasoningEffort,
      webSearchMode: 'disabled'
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const abortFromCaller = () => controller.abort()
    signal?.addEventListener?.('abort', abortFromCaller, { once: true })
    let turn
    try {
      turn = await thread.run(buildTranscript(messages), {
        outputSchema: OUTPUT_SCHEMA,
        signal: controller.signal
      })
    } catch {
      if (controller.signal.aborted) throw new CodexClientError('Codex request timed out', 'REQUEST_TIMEOUT')
      throw new CodexClientError('Codex turn failed', 'CODEX_TURN_FAILED')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener?.('abort', abortFromCaller)
      fs.rmSync(instructionsFile, { force: true })
    }
    return parseCodexOutput(turn.finalResponse)
  }
}
