import { defineIntegration } from '../../lib/integration.js'
import { dispatchCommand } from '../../lib/command-dispatcher.js'

export default defineIntegration({
  id: 'phi',
  version: '2.3.0',
  systemPromptFile: new URL('./SYSTEM_PROMPT.md', import.meta.url),
  handlers: { dispatchCommand },
  capabilities: [
    {
      name: 'phi_execute_command',
      description: 'Handle one documented end-user Phi (Phigros) request. Supply a brief, natural user-facing preface before the command runs. Use only public user commands; never invoke admin or API-management commands, and do not claim a result before it is returned.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            minLength: 5,
            maxLength: 1000,
            pattern: '^[#/][a-zA-Z0-9_-]+'
          },
          preface: {
            type: 'string',
            minLength: 1,
            maxLength: 160,
            pattern: '^[^\\r\\n]+$'
          }
        },
        required: ['command', 'preface'],
        additionalProperties: false
      },
      handler: 'dispatchCommand'
    }
  ]
})
