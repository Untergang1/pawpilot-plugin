import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { CapabilityError } from '../lib/ai-capabilities.js'
import { defineIntegration } from '../lib/integration.js'

test('integration resolves declared handler names and reads its public guide', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pawpilot-plugin-guide-'))
  const guide = path.join(directory, 'SYSTEM_PROMPT.md')
  await fs.writeFile(guide, 'Use this integration only for its documented read-only purpose.', 'utf8')
  try {
    const integration = defineIntegration({
      id: 'guide-test',
      systemPromptFile: pathToFileURL(guide),
      handlers: { status: () => ({ ok: true }) },
      capabilities: [{
        name: 'guide_test_status',
        description: 'Reads status.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: 'status'
      }]
    })
    assert.equal(integration.systemPrompt, 'Use this integration only for its documented read-only purpose.')
    assert.deepEqual(await integration.capabilities[0].execute({}, {}), { ok: true })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('integration rejects a capability whose handler is not explicitly registered', () => {
  assert.throws(
    () => defineIntegration({
      id: 'missing-handler',
      handlers: {},
      capabilities: [{
        name: 'missing_handler_tool',
        description: 'A tool.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: 'missing'
      }]
    }),
    error => error instanceof CapabilityError && error.code === 'HANDLER_NOT_FOUND'
  )
})
