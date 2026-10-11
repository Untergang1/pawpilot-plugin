import cfg from '../../lib/config/config.js'
import { CapabilityModuleLoader } from './lib/capability-loader.js'
import { getAgentConfig } from './lib/config.js'
import { createRequestPipeline } from './lib/request-pipeline.js'

const registryLoader = new CapabilityModuleLoader()
let loadedModuleKey = ''

async function reloadModules (moduleIds) {
  registryLoader.moduleIds = moduleIds
  const capabilities = await registryLoader.reload()
  loadedModuleKey = moduleIds.join(',')
  return capabilities
}

async function getRegistry (config) {
  if (config.capabilityModules.join(',') !== loadedModuleKey) await reloadModules(config.capabilityModules)
  return registryLoader.registry
}

function isOwner (event) {
  if (event.isMaster === true) return true
  const owners = cfg.master?.[event.self_id] ?? []
  return owners.includes(String(event.user_id))
}

const pipeline = createRequestPipeline({ getRegistry, isOwner })

export class pawPilot extends plugin {
  constructor () {
    super({
      name: 'PawPilot',
      dsc: 'LLM function-calling assistant (DashScope or ChatGPT)',
      event: 'message',
      priority: 900,
      rule: [
        { reg: '^#ai\\s*reload$', fnc: 'reloadCapabilities', permission: 'master' },
        { reg: '^#ai\\s*(重置|reset|新话题)$', fnc: 'resetConversation', permission: 'master' }
      ]
    })
  }

  async resetConversation () {
    return this.reply(pipeline.reset(this.e), true)
  }

  async reloadCapabilities () {
    try {
      const capabilities = await reloadModules(getAgentConfig().capabilityModules)
      return this.reply(`AI 能力及集成提示词已重载：${capabilities.map(item => item.name).join('、') || '无'}`, true)
    } catch (error) {
      global.logger?.error?.('[pawpilot-plugin] capability reload failed', error)
      return this.reply('AI 能力重载失败，请检查安全日志和能力模块配置。', true)
    }
  }

  async accept (event) {
    return pipeline.handle(event, getAgentConfig(), text => this.reply(text, true))
  }
}
