import { positiveInteger } from './util.js'

/**
 * Process-local FIFO queues keyed by bot and group. Accepted work waits silently;
 * callers decide how to report capacity rejection.
 */
export class GroupRequestQueue {
  #entries = new Map()

  enqueue (key, task, maxOutstanding = 8) {
    maxOutstanding = positiveInteger(maxOutstanding, 8)
    const previous = this.#entries.get(key)
    const outstanding = previous?.outstanding ?? 0
    if (outstanding >= maxOutstanding) return { ok: false, reason: 'FULL' }

    const entry = previous ?? { tail: Promise.resolve(), outstanding: 0 }
    entry.outstanding += 1
    const run = entry.tail.catch(() => {}).then(task)
    entry.tail = run.then(() => {}, () => {}).finally(() => {
      entry.outstanding = Math.max(0, entry.outstanding - 1)
      if (entry.outstanding === 0 && this.#entries.get(key) === entry) {
        this.#entries.delete(key)
      }
    })
    this.#entries.set(key, entry)
    return { ok: true, promise: run }
  }

  outstanding (key) {
    return this.#entries.get(key)?.outstanding ?? 0
  }
}
