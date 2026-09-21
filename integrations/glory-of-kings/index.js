import { defineIntegration } from '../../lib/integration.js'
import { dispatchCommand } from '../../lib/command-dispatcher.js'

export default defineIntegration({
  id: 'glory-of-kings',
  version: '1.1.0',
  systemPromptFile: new URL('./SYSTEM_PROMPT.md', import.meta.url),
  handlers: { dispatchCommand },
  capabilities: [
    {
      name: 'glory_of_kings_execute_command',
      description: 'Handle one documented Glory of Kings end-user request. Supply a brief, natural user-facing preface before the command runs.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            minLength: 2,
            maxLength: 1000,
            pattern: '^[#/][^\\s#/]+'
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
