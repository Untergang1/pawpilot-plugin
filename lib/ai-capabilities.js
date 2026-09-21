/**
 * Explicit, validated capabilities exposed to the AI agent.
 * This module deliberately has no Yunzai dependency so it is easy to test.
 */

export const AI_CAPABILITY_SCHEMA_VERSION = '1.3'
export const MAX_BASE_SYSTEM_PROMPT_CHARS = 12_000
export const MAX_MODULE_SYSTEM_PROMPT_CHARS = 6_000
export const MAX_TOTAL_MODULE_SYSTEM_PROMPT_CHARS = 24_000
export const MAX_TOTAL_SYSTEM_PROMPT_CHARS = 36_000

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/
const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean'])

export class CapabilityError extends Error {
  constructor (message, code = 'CAPABILITY_ERROR') {
    super(message)
    this.name = 'CapabilityError'
    this.code = code
  }
}

function isPlainObject (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cloneAndFreeze (value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze))
  if (isPlainObject(value)) {
    const result = Object.create(null)
    for (const [key, child] of Object.entries(value)) result[key] = cloneAndFreeze(child)
    return Object.freeze(result)
  }
  return value
}

function assertSchemaDefinition (schema, path = 'inputSchema') {
  if (!isPlainObject(schema) || !SCHEMA_TYPES.has(schema.type)) {
    throw new CapabilityError(`${path} must declare a supported type`, 'INVALID_SCHEMA')
  }
  if (schema.enum && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new CapabilityError(`${path}.enum must be a non-empty array`, 'INVALID_SCHEMA')
  }
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) {
      throw new CapabilityError(`${path}.additionalProperties must be false`, 'INVALID_SCHEMA')
    }
    if (schema.properties !== undefined && !isPlainObject(schema.properties)) {
      throw new CapabilityError(`${path}.properties must be an object`, 'INVALID_SCHEMA')
    }
    const properties = schema.properties ?? {}
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length) {
        throw new CapabilityError(`${path}.required must be a unique array`, 'INVALID_SCHEMA')
      }
      for (const key of schema.required) {
        if (typeof key !== 'string' || !(key in properties)) {
          throw new CapabilityError(`${path}.required contains an unknown property`, 'INVALID_SCHEMA')
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new CapabilityError(`${path}.properties has an unsafe key`, 'INVALID_SCHEMA')
      }
      assertSchemaDefinition(child, `${path}.properties.${key}`)
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    assertSchemaDefinition(schema.items, `${path}.items`)
  }
}

/**
 * @typedef {Object} CapabilityContext
 * @property {object} event Original Yunzai event. Never include it in model messages.
 * @property {string} userId
 * @property {string | undefined} groupId
 * @property {boolean} isOwner
 * @property {{requestId: string}} session
 */

/**
 * Define a module maintained by a plugin.
 * systemPrompt is model-facing documentation only; it is not executable.
 */
export function defineCapabilityModule (definition) {
  if (!isPlainObject(definition)) {
    throw new CapabilityError('Capability module must be an object', 'INVALID_MODULE')
  }
  if (!PLUGIN_ID.test(definition.id ?? '')) {
    throw new CapabilityError('Module id must be lowercase letters, digits, or hyphens', 'INVALID_MODULE_ID')
  }
  if (!Array.isArray(definition.capabilities) || definition.capabilities.length === 0) {
    throw new CapabilityError('Capability module must contain at least one capability', 'EMPTY_MODULE')
  }
  if (definition.systemPrompt !== undefined) {
    if (typeof definition.systemPrompt !== 'string' || !definition.systemPrompt.trim()) {
      throw new CapabilityError('systemPrompt must be a non-empty string', 'INVALID_SYSTEM_PROMPT')
    }
    if (definition.systemPrompt.trim().length > MAX_MODULE_SYSTEM_PROMPT_CHARS) {
      throw new CapabilityError('systemPrompt is too long', 'SYSTEM_PROMPT_TOO_LONG')
    }
  }

  const names = new Set()
  const capabilities = definition.capabilities.map(capability => {
    if (!isPlainObject(capability) || !TOOL_NAME.test(capability.name ?? '')) {
      throw new CapabilityError(`Invalid tool name: ${capability?.name}`, 'INVALID_TOOL_NAME')
    }
    if (names.has(capability.name)) {
      throw new CapabilityError(`Duplicate tool name: ${capability.name}`, 'DUPLICATE_TOOL_NAME')
    }
    names.add(capability.name)
    if (typeof capability.description !== 'string' || !capability.description.trim()) {
      throw new CapabilityError(`${capability.name} is missing a description`, 'MISSING_DESCRIPTION')
    }
    if (typeof capability.execute !== 'function') {
      throw new CapabilityError(`${capability.name} is missing an executor`, 'MISSING_EXECUTOR')
    }
    if (Object.prototype.hasOwnProperty.call(capability, 'commandHelp')) {
      throw new CapabilityError(`${capability.name}.commandHelp was removed; put command rules in the module systemPrompt`, 'COMMAND_HELP_REMOVED')
    }
    const inputSchema = capability.inputSchema ?? {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
    assertSchemaDefinition(inputSchema)
    return Object.freeze({
      name: capability.name,
      description: capability.description.trim(),
      inputSchema: cloneAndFreeze(inputSchema),
      ownerOnly: capability.ownerOnly === true,
      execute: capability.execute
    })
  })

  return Object.freeze({
    schemaVersion: AI_CAPABILITY_SCHEMA_VERSION,
    id: definition.id,
    version: typeof definition.version === 'string' && definition.version ? definition.version : '0.0.0',
    systemPrompt: definition.systemPrompt?.trim() || undefined,
    capabilities: Object.freeze(capabilities)
  })
}

export class CapabilityRegistry {
  #tools = new Map()
  #plugins = new Map()

  register (module) {
    const validated = defineCapabilityModule(module)
    const oldModule = this.#plugins.get(validated.id)
    const oldToolNames = new Set(oldModule?.capabilities.map(item => item.name) ?? [])
    this.#assertSystemPromptBudget([
      ...[...this.#plugins.values()].filter(item => item.id !== validated.id),
      validated
    ])

    for (const capability of validated.capabilities) {
      if (this.#tools.has(capability.name) && !oldToolNames.has(capability.name)) {
        throw new CapabilityError(`Tool name is already owned by another module: ${capability.name}`, 'TOOL_NAME_CONFLICT')
      }
    }

    if (oldModule) this.unregister(validated.id)
    for (const capability of validated.capabilities) {
      this.#tools.set(capability.name, { plugin: validated, capability })
    }
    this.#plugins.set(validated.id, validated)
    return validated
  }

  /** Atomically replace the complete module set after every module validates. */
  replace (modules) {
    if (!Array.isArray(modules)) throw new CapabilityError('modules must be an array', 'INVALID_MODULES')
    const staged = new CapabilityRegistry()
    for (const module of modules) staged.register(module)
    this.#tools = staged.#tools
    this.#plugins = staged.#plugins
    return this.list({ isOwner: true })
  }

  unregister (pluginId) {
    const module = this.#plugins.get(pluginId)
    if (!module) return false
    for (const capability of module.capabilities) this.#tools.delete(capability.name)
    this.#plugins.delete(pluginId)
    return true
  }

  toModelTools ({ isOwner = false } = {}) {
    return [...this.#tools.values()]
      .filter(({ capability }) => isOwner || !capability.ownerOnly)
      .map(({ capability }) => ({
        type: 'function',
        function: {
          name: capability.name,
          description: capability.description,
          parameters: capability.inputSchema
        }
      }))
  }

  list ({ isOwner = false } = {}) {
    return [...this.#tools.values()]
      .filter(({ capability }) => isOwner || !capability.ownerOnly)
      .map(({ plugin, capability }) => ({
        plugin: plugin.id,
        version: plugin.version,
        name: capability.name,
        description: capability.description,
        ownerOnly: capability.ownerOnly
      }))
  }

  getSystemPrompts () {
    return [...this.#plugins.values()]
      .filter(module => module.systemPrompt)
      .map(module => ({ plugin: module.id, content: module.systemPrompt }))
  }

  async invoke (toolName, args, context) {
    const entry = this.#tools.get(toolName)
    if (!entry) throw new CapabilityError(`Unregistered tool: ${toolName}`, 'TOOL_NOT_FOUND')
    if (!isPlainObject(args)) throw new CapabilityError('Tool arguments must be an object', 'INVALID_ARGUMENTS')
    if (!isPlainObject(context) || !context.event || typeof context.event !== 'object') {
      throw new CapabilityError('Capability context is invalid', 'INVALID_CONTEXT')
    }
    if (entry.capability.ownerOnly && !context.isOwner) {
      throw new CapabilityError('This capability is owner-only', 'OWNER_REQUIRED')
    }
    assertSchema(args, entry.capability.inputSchema)
    return entry.capability.execute(args, context)
  }

  #assertSystemPromptBudget (modules) {
    const length = modules.reduce((total, module) => total + (module.systemPrompt?.length ?? 0), 0)
    if (length > MAX_TOTAL_MODULE_SYSTEM_PROMPT_CHARS) {
      throw new CapabilityError('Combined system prompts are too long', 'SYSTEM_PROMPT_BUDGET_EXCEEDED')
    }
  }
}

/** Runtime validator for the deliberately small JSON Schema subset used by tools. */
export function assertSchema (value, schema, path = '$') {
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) {
    throw new CapabilityError(`${path} is not an allowed value`, 'INVALID_ARGUMENTS')
  }
  const matches = {
    object: isPlainObject(value),
    array: Array.isArray(value),
    string: typeof value === 'string',
    number: typeof value === 'number' && Number.isFinite(value),
    integer: Number.isInteger(value),
    boolean: typeof value === 'boolean'
  }
  if (!matches[schema.type]) {
    throw new CapabilityError(`${path} must be ${schema.type}`, 'INVALID_ARGUMENTS')
  }
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) throw new CapabilityError(`${path}.${key} is required`, 'INVALID_ARGUMENTS')
    }
    for (const key of Object.keys(value)) {
      if (!(key in (schema.properties ?? {}))) {
        throw new CapabilityError(`${path}.${key} is not allowed`, 'INVALID_ARGUMENTS')
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in value) assertSchema(value[key], childSchema, `${path}.${key}`)
    }
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new CapabilityError(`${path} has too few items`, 'INVALID_ARGUMENTS')
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new CapabilityError(`${path} has too many items`, 'INVALID_ARGUMENTS')
    }
    if (schema.items) value.forEach((item, index) => assertSchema(item, schema.items, `${path}[${index}]`))
  }
  if (schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new CapabilityError(`${path} is too short`, 'INVALID_ARGUMENTS')
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new CapabilityError(`${path} is too long`, 'INVALID_ARGUMENTS')
    }
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) {
      throw new CapabilityError(`${path} has an invalid format`, 'INVALID_ARGUMENTS')
    }
  }
}
