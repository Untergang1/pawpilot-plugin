import fs from 'node:fs'
import { CapabilityError, defineCapabilityModule } from './ai-capabilities.js'

function readSystemPrompt (file) {
  if (!(file instanceof URL) || file.protocol !== 'file:') {
    throw new CapabilityError('systemPromptFile must be a local file URL', 'INVALID_SYSTEM_PROMPT_FILE')
  }
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    throw new CapabilityError('Unable to read integration system prompt file', 'SYSTEM_PROMPT_FILE_NOT_FOUND')
  }
}

/**
 * Defines an pawpilot-plugin-owned integration. Integrations declare handler names rather than
 * embedding execute functions in every tool declaration.
 */
export function defineIntegration ({ handlers = {}, systemPromptFile, capabilities = [], ...module }) {
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw new CapabilityError('handlers must be an object', 'INVALID_HANDLERS')
  }
  const resolvedCapabilities = capabilities.map(capability => {
    const handler = handlers[capability.handler]
    if (typeof capability.handler !== 'string' || typeof handler !== 'function') {
      throw new CapabilityError(`${capability.name ?? 'capability'} has no registered handler`, 'HANDLER_NOT_FOUND')
    }
    const { handler: _handlerName, ...definition } = capability
    return { ...definition, execute: handler }
  })
  return defineCapabilityModule({
    ...module,
    systemPrompt: systemPromptFile ? readSystemPrompt(systemPromptFile) : undefined,
    capabilities: resolvedCapabilities
  })
}
