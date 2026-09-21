import { defineIntegration } from '../lib/integration.js'

async function getCurrentUserSummary (_args, context) {
  return { ok: true, userId: context.userId, message: 'Replace with a small business adapter.' }
}

export default defineIntegration({
  id: 'example',
  version: '1.0.0',
  systemPromptFile: new URL('./SYSTEM_PROMPT.md', import.meta.url),
  handlers: { getCurrentUserSummary },
  capabilities: [
    {
      name: 'example_current_user_summary',
      description: 'Read a non-sensitive summary belonging only to the current request user.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      handler: 'getCurrentUserSummary'
    }
  ]
})
