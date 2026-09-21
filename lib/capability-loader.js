import { CapabilityRegistry } from './ai-capabilities.js'
import { INTEGRATION_MODULES } from '../integrations/registry.js'

export class CapabilityModuleLoader {
  constructor ({ registry = new CapabilityRegistry(), moduleIds = [] } = {}) {
    this.registry = registry
    this.moduleIds = moduleIds
  }

  async reload () {
    const modules = []
    for (const id of this.moduleIds) {
      const url = INTEGRATION_MODULES[id]
      if (!url) throw new Error(`Unknown capability module: ${id}`)
      const imported = await import(`${url.href}?reload=${Date.now()}`)
      modules.push(imported.default ?? imported.capabilityModule)
    }
    this.registry.replace(modules)
    return this.registry.list({ isOwner: true })
  }
}
