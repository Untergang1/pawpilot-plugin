import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CapabilityError,
  CapabilityRegistry,
  MAX_MODULE_SYSTEM_PROMPT_CHARS,
  MAX_TOTAL_MODULE_SYSTEM_PROMPT_CHARS,
  defineCapabilityModule
} from '../lib/ai-capabilities.js'

function module (overrides = {}) {
  return defineCapabilityModule({
    id: 'test-plugin',
    version: '1.0.0',
    capabilities: [{
      name: 'test_lookup',
      description: 'Lookup a test value.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string', minLength: 1, maxLength: 10 } },
        required: ['value'],
        additionalProperties: false
      },
      async execute ({ value }, context) {
        return { value, caller: context.userId }
      },
      ...overrides
    }]
  })
}

test('registry validates arguments before it invokes business code', async () => {
  const registry = new CapabilityRegistry()
  registry.register(module())

  await assert.rejects(
    registry.invoke('test_lookup', { unknown: 'x' }, { event: {}, userId: '42', isOwner: false }),
    error => error instanceof CapabilityError && error.code === 'INVALID_ARGUMENTS'
  )
  assert.deepEqual(
    await registry.invoke('test_lookup', { value: 'ok' }, { event: {}, userId: '42', isOwner: false }),
    { value: 'ok', caller: '42' }
  )
})

test('owner-only tools are hidden and blocked twice', async () => {
  const registry = new CapabilityRegistry()
  registry.register(module({ ownerOnly: true }))
  assert.equal(registry.toModelTools({ isOwner: false }).length, 0)
  await assert.rejects(
    registry.invoke('test_lookup', { value: 'ok' }, { event: {}, userId: '42', isOwner: false }),
    error => error instanceof CapabilityError && error.code === 'OWNER_REQUIRED'
  )
})

test('description remains available for tool selection and capability listing', () => {
  const registry = new CapabilityRegistry()
  registry.register(module())
  assert.equal(registry.toModelTools()[0].function.description, 'Lookup a test value.')
  const listed = registry.list()[0]
  assert.equal(listed.description, 'Lookup a test value.')
  assert.equal(Object.hasOwn(listed, 'commandHelp'), false)
})

test('replacing modules is atomic when a new module conflicts', () => {
  const registry = new CapabilityRegistry()
  registry.register(module())
  const conflict = defineCapabilityModule({
    id: 'other-plugin',
    capabilities: [{
      name: 'test_lookup',
      description: 'Conflicting name.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => ({ ok: true })
    }]
  })
  assert.throws(() => registry.replace([module(), conflict]), error => error.code === 'TOOL_NAME_CONFLICT')
  assert.equal(registry.list({ isOwner: true })[0].plugin, 'test-plugin')
})

test('object schemas must close additional properties', () => {
  assert.throws(
    () => defineCapabilityModule({
      id: 'unsafe',
      capabilities: [{
        name: 'unsafe_tool',
        description: 'Unsafe.',
        inputSchema: { type: 'object', properties: {} },
        execute: () => ({})
      }]
    }),
    error => error.code === 'INVALID_SCHEMA'
  )
})

test('commandHelp is rejected because command rules belong in the module guide', () => {
  assert.throws(
    () => module({ commandHelp: 'Legacy command documentation.' }),
    error => error instanceof CapabilityError && error.code === 'COMMAND_HELP_REMOVED'
  )
})

test('module system prompts are validated and exposed separately from tools', () => {
  const registry = new CapabilityRegistry()
  registry.register(defineCapabilityModule({
    id: 'guided-plugin',
    systemPrompt: 'Only use the documented capability for this plugin.',
    capabilities: [{
      name: 'guided_tool',
      description: 'A guided tool.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => ({ ok: true })
    }]
  }))
  assert.deepEqual(registry.getSystemPrompts(), [{
    plugin: 'guided-plugin',
    content: 'Only use the documented capability for this plugin.'
  }])
  assert.throws(
    () => defineCapabilityModule({
      id: 'oversized-guide',
      systemPrompt: 'x'.repeat(MAX_MODULE_SYSTEM_PROMPT_CHARS + 1),
      capabilities: [{
        name: 'oversized_guide_tool',
        description: 'A tool.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        execute: () => ({ ok: true })
      }]
    }),
    error => error.code === 'SYSTEM_PROMPT_TOO_LONG'
  )
})

test('combined plugin guides use the separate second-level prompt budget', () => {
  const registry = new CapabilityRegistry()
  const guide = 'x'.repeat(MAX_MODULE_SYSTEM_PROMPT_CHARS)
  const fullGuides = MAX_TOTAL_MODULE_SYSTEM_PROMPT_CHARS / MAX_MODULE_SYSTEM_PROMPT_CHARS
  assert.ok(Number.isInteger(fullGuides), 'the total budget holds a whole number of full guides')
  for (const id of Array.from({ length: fullGuides }, (_, index) => `guide${index}`)) {
    registry.register(defineCapabilityModule({
      id,
      systemPrompt: guide,
      capabilities: [{
        name: `${id}_tool`,
        description: 'A tool.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        execute: () => ({ ok: true })
      }]
    }))
  }
  assert.equal(
    registry.getSystemPrompts().reduce((total, prompt) => total + prompt.content.length, 0),
    MAX_TOTAL_MODULE_SYSTEM_PROMPT_CHARS
  )
  assert.throws(
    () => registry.register(defineCapabilityModule({
      id: 'overflow',
      systemPrompt: guide,
      capabilities: [{
        name: 'overflow_tool',
        description: 'A tool.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        execute: () => ({ ok: true })
      }]
    })),
    error => error.code === 'SYSTEM_PROMPT_BUDGET_EXCEEDED'
  )
})
