const MAX_COMMAND_LENGTH = 1_000
const MAX_PREFACE_LENGTH = 160

function commandPrefix (command) {
  return command.match(/^[#/](?<prefix>[^\s#/]+)/u)?.groups?.prefix ?? null
}

/**
 * Builds the event of a text-only message carrying just the command from the same
 * sender. Yunzai's `deal` derives `msg`, `img` and `file` from `message`, so the
 * inherited values are cleared; `at`, `atBot` and `reply_id` stay inherited so the
 * command keeps the original mention and quote context.
 */
function cloneCommandEvent (event, command) {
  const clone = Object.create(event)
  const own = value => ({ value, writable: true, enumerable: true, configurable: true })
  Object.defineProperties(clone, {
    aiCommandDispatch: { value: true, enumerable: false },
    message: own([{ type: 'text', text: command }]),
    raw_message: own(command),
    msg: own(undefined),
    img: own(undefined),
    file: own(undefined)
  })
  return clone
}

async function defaultDispatch (event) {
  const { default: pluginsLoader } = await import('../../../lib/plugins/loader.js')
  return pluginsLoader.deal(event)
}

/**
 * Routes a model-selected command through Yunzai's message entry point (`deal`), as
 * if the sender had sent the command themselves, so blacklists, cooldowns,
 * @-only settings and permissions apply as usual. Target-plugin behavior,
 * confirmations and replies stay owned by the target plugin; this adapter only
 * validates the basic command format.
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
    // user while keeping the command itself an implementation detail. The sent
    // preface is returned so the turn can enter conversation history.
    const text = preface.trim()
    const sendResult = await context.event.reply(text, true)
    await dispatch(cloneCommandEvent(context.event, normalized))
    return { ok: true, handled: true, reply: { text, sendResult } }
  }
}

export const dispatchCommand = createCommandDispatcher()
