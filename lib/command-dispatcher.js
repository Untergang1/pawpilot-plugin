const MAX_COMMAND_LENGTH = 1_000
const MAX_PREFACE_LENGTH = 160

function commandPrefix (command) {
  return command.match(/^[#/](?<prefix>[^\s#/]+)/u)?.groups?.prefix ?? null
}

function cloneCommandEvent (event, command) {
  const clone = Object.create(event)
  Object.defineProperties(clone, {
    aiCommandDispatch: { value: true, enumerable: false },
    msg: { value: command, writable: true, enumerable: true, configurable: true }
  })
  return clone
}

async function defaultDispatch (event) {
  const { default: pluginsLoader } = await import('../../../lib/plugins/loader.js')
  return pluginsLoader.dispatchPlugins(event)
}

/**
 * Routes a model-selected command through Yunzai's normal plugin dispatcher.
 * Target-plugin behavior, authorization, confirmations and replies stay owned by
 * the target plugin; this adapter only validates the basic command format.
 */
export function createCommandDispatcher ({ dispatch = defaultDispatch } = {}) {
  return async function dispatchCommand ({ command, preface }, context) {
    if (typeof command !== 'string' || command.length > MAX_COMMAND_LENGTH || /[\r\n]/.test(command)) {
      return { ok: false, code: 'INVALID_COMMAND', message: '命令格式不正确。' }
    }

    const normalized = command.trim()
    if (!commandPrefix(normalized)) {
      return { ok: false, code: 'INVALID_COMMAND', message: '命令格式不正确。' }
    }

    if (typeof preface !== 'string' || !preface.trim() || preface.length > MAX_PREFACE_LENGTH || /[\r\n]/.test(preface)) {
      return { ok: false, code: 'INVALID_PREFACE', message: '前置回复格式不正确。' }
    }

    // Acknowledging the request before dispatch makes the handoff visible to the
    // user while keeping the command itself an implementation detail.
    await context.event.reply(preface.trim(), true)
    await dispatch(cloneCommandEvent(context.event, normalized))
    return { ok: true, handled: true }
  }
}

export const dispatchCommand = createCommandDispatcher()
