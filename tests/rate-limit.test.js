import assert from 'node:assert/strict'
import test from 'node:test'
import { RequestLimiter } from '../lib/rate-limit.js'

test('rate-only consumption allows queued group requests without a concurrency busy result', () => {
  const limiter = new RequestLimiter({ maxRequests: 2, maxConcurrent: 1 })
  assert.equal(limiter.consume('group-user').ok, true)
  assert.equal(limiter.consume('group-user').ok, true)
  assert.equal(limiter.consume('group-user').reason, 'RATE_LIMITED')
})

test('private acquisition retains its concurrency guard', () => {
  const limiter = new RequestLimiter({ maxRequests: 2, maxConcurrent: 1 })
  const first = limiter.acquire('private-user')
  assert.equal(first.ok, true)
  assert.equal(limiter.acquire('private-user').reason, 'BUSY')
  first.release()
  assert.equal(limiter.acquire('private-user').ok, true)
})
