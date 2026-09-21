import assert from 'node:assert/strict'
import test from 'node:test'
import { GroupRequestQueue } from '../lib/group-request-queue.js'

function deferred () {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('group queue runs one task at a time in arrival order', async () => {
  const queue = new GroupRequestQueue()
  const gate = deferred()
  const events = []
  const first = queue.enqueue('group-a', async () => {
    events.push('first:start')
    await gate.promise
    events.push('first:end')
  })
  const second = queue.enqueue('group-a', async () => {
    events.push('second:start')
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['first:start'])
  assert.equal(queue.outstanding('group-a'), 2)
  gate.resolve()
  await Promise.all([first.promise, second.promise])
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start'])
  await Promise.resolve()
  assert.equal(queue.outstanding('group-a'), 0)
})

test('group queue isolates groups, enforces capacity, and continues after failure', async () => {
  const queue = new GroupRequestQueue()
  const gate = deferred()
  const blocked = queue.enqueue('group-a', () => gate.promise, 2)
  const failed = queue.enqueue('group-a', async () => { throw new Error('failed') }, 2)
  assert.equal(queue.enqueue('group-a', async () => {}, 2).reason, 'FULL')

  let otherRan = false
  await queue.enqueue('group-b', async () => { otherRan = true }, 2).promise
  assert.equal(otherRan, true)

  gate.resolve()
  await blocked.promise
  await assert.rejects(failed.promise, /failed/)
  const afterFailure = queue.enqueue('group-a', async () => 'ok', 2)
  assert.equal(await afterFailure.promise, 'ok')
})
