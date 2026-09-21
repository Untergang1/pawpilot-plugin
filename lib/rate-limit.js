export class RequestLimiter {
  #entries = new Map()

  constructor ({ windowMs = 60_000, maxRequests = 6, maxConcurrent = 1 } = {}) {
    this.windowMs = windowMs
    this.maxRequests = maxRequests
    this.maxConcurrent = maxConcurrent
  }

  acquire (key) {
    const now = Date.now()
    const entry = this.#entries.get(key) ?? { started: [], concurrent: 0 }
    entry.started = entry.started.filter(timestamp => now - timestamp < this.windowMs)
    if (entry.concurrent >= this.maxConcurrent) return { ok: false, reason: 'BUSY' }
    if (entry.started.length >= this.maxRequests) return { ok: false, reason: 'RATE_LIMITED' }
    entry.started.push(now)
    entry.concurrent += 1
    this.#entries.set(key, entry)
    return {
      ok: true,
      release: () => {
        entry.concurrent = Math.max(0, entry.concurrent - 1)
        if (entry.concurrent === 0 && entry.started.length === 0) this.#entries.delete(key)
      }
    }
  }

  consume (key) {
    const now = Date.now()
    const entry = this.#entries.get(key) ?? { started: [], concurrent: 0 }
    entry.started = entry.started.filter(timestamp => now - timestamp < this.windowMs)
    if (entry.started.length >= this.maxRequests) return { ok: false, reason: 'RATE_LIMITED' }
    entry.started.push(now)
    this.#entries.set(key, entry)
    return { ok: true }
  }
}
