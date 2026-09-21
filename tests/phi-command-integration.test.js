import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'

test('Phi integration exposes only the command-dispatch capability', async () => {
  const { default: integration } = await import(`../integrations/phi/index.js?test=${Date.now()}`)
  assert.equal(integration.id, 'phi')
  assert.deepEqual(integration.capabilities.map(capability => capability.name), ['phi_execute_command'])
  assert.match(integration.capabilities[0].description, /brief, natural user-facing preface/)
  assert.deepEqual(integration.capabilities[0].inputSchema.required, ['command', 'preface'])
  assert.equal(Object.hasOwn(integration.capabilities[0], 'commandHelp'), false)
})

test('Phi system guide documents user commands and tells the model to avoid administrator commands', () => {
  const guide = fs.readFileSync(new URL('../integrations/phi/SYSTEM_PROMPT.md', import.meta.url), 'utf8')
  assert.ok(guide.length <= 6_000)
  assert.match(guide, /#phi bind/)
  assert.match(guide, /#phi tag/)
  assert.match(guide, /#phi sign/)
  assert.match(guide, /#phi ans/)
  assert.match(guide, /不要派发管理员、主人或 API 管理命令/)
  assert.doesNotMatch(guide, /#phi backup/)
  assert.doesNotMatch(guide, /#phi restore/)
  assert.doesNotMatch(guide, /#phi setApiToken/)
})
