import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeDropped, summaryMessage } from '../lib/conversation-summary.js'

test('summaries fold dropped text into the previous summary at low effort without tools', async () => {
  let request
  const client = {
    async complete (options) {
      request = options
      return { content: '  x'.padEnd(50, 'y'), usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0 } }
    }
  }
  const result = await summarizeDropped({ client, summary: 'old', dropped: ['user: hi', 'assistant: hello'], maxChars: 10 })
  assert.equal(result.summary.length, 10)
  assert.equal(request.reasoningEffort, 'low')
  assert.deepEqual(request.tools, [])
  assert.match(request.messages[0].content, /at most 10 characters/)
  assert.match(request.messages[1].content, /Previous summary:\nold/)
  assert.match(request.messages[1].content, /user: hi\nassistant: hello/)
  assert.equal(summaryMessage(''), null)
  assert.deepEqual(summaryMessage('s'), { role: 'user', content: '[Earlier conversation summary]\ns' })
})
