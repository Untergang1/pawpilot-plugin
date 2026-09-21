import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { assertSchema } from '../lib/ai-capabilities.js'
import { INTEGRATION_MODULES } from '../integrations/registry.js'

test('Glory of Kings integration exposes only the command-dispatch capability', async () => {
  const { default: integration } = await import(`../integrations/glory-of-kings/index.js?test=${Date.now()}`)
  assert.equal(integration.id, 'glory-of-kings')
  assert.deepEqual(integration.capabilities.map(capability => capability.name), ['glory_of_kings_execute_command'])
  assert.match(integration.capabilities[0].description, /brief, natural user-facing preface/)
  assert.equal(Object.hasOwn(integration.capabilities[0], 'commandHelp'), false)
  assert.doesNotThrow(() => assertSchema({ command: '#王者帮助', preface: '我来帮你看看喵~' }, integration.capabilities[0].inputSchema))
  assert.throws(() => assertSchema({ command: '#王者帮助' }, integration.capabilities[0].inputSchema))
  assert.throws(() => assertSchema({ command: '#'}, integration.capabilities[0].inputSchema))
  assert.ok(INTEGRATION_MODULES['glory-of-kings'] instanceof URL)
})

test('Glory of Kings guide documents public commands and excludes administrator commands', () => {
  const guide = fs.readFileSync(new URL('../integrations/glory-of-kings/SYSTEM_PROMPT.md', import.meta.url), 'utf8')
  assert.ok(guide.length <= 6_000)
  assert.match(guide, /#王者帮助/)
  assert.match(guide, /#绑定营地/)
  assert.match(guide, /#营地wx登录/)
  assert.match(guide, /#查询战绩/)
  assert.match(guide, /#查皮肤/)
  assert.match(guide, /明确确认/)
  assert.doesNotMatch(guide, /#共享营地账号 <QQ号>/)
})
