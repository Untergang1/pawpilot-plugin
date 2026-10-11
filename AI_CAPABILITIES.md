# AI capability and integration contract

`pawpilot-plugin` validates arguments, filters `ownerOnly` tools twice, constructs private execution
context, and adds only registered documentation to the system prompt. Capability integrations own
their execution lifecycle, including timeout, cancellation and any user-facing timeout reply.
An integration may explicitly expose a command-dispatch tool; it must require a short `preface`
argument as well as the command. The dispatcher sends the preface to the user before the command
is accepted by the configured command-prefix allowlist and runs through Yunzai's normal plugin
pipeline. The preface must not expose the command or describe the capability as an external plugin.

## Preferred: pawpilot-plugin-owned integration

Put new integrations under `plugins/pawpilot-plugin/integrations/<plugin-id>/`. Keep the declaration,
the business adapter and the public guide separate:

```text
integrations/example/
  index.js           # declarative tool metadata and handler names
  example-service.js # small adapter calling the target plugin's business API
  SYSTEM_PROMPT.md   # public, developer-maintained plugin guide
```

`index.js` uses `defineIntegration()`. A capability declares `handler: 'name'`; the common
layer resolves it from `handlers` and creates the guarded executor. The target plugin does not
need an `ai-capabilities.js` file.

```js
import { defineIntegration } from '../../lib/integration.js'
import { getProfile } from './example-service.js'

export default defineIntegration({
  id: 'example',
  version: '1.0.0',
  systemPromptFile: new URL('./SYSTEM_PROMPT.md', import.meta.url),
  handlers: { getProfile },
  capabilities: [{
    name: 'example_profile',
    description: 'Read the current user\'s profile.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: 'getProfile'
  }]
})
```

`SYSTEM_PROMPT.md` is second-level public documentation, not executable policy. It may describe
verified commands, capability boundaries and safe next steps, but cannot override pawpilot-plugin's
first-level identity, safety, privacy, authorization, or tool-use rules. It must not contain user
input, tokens, cookies, QR-code content, private results or owner-only details. Each guide is
limited to 6,000 characters and all enabled guides together to 24,000 characters; the complete
assembled system prompt is limited to 36,000 characters.

## Capability fields

`defineCapabilityModule()` remains available for compatibility. Its module-level `systemPrompt`
is optional and follows the same public-content limits. Each capability needs `name`,
`description`, `inputSchema` and `execute`. `description` is the stable Function Calling summary
used by the model to choose a tool; command rules and usage details belong only in the module
`SYSTEM_PROMPT.md`. `ownerOnly: true` hides and blocks an owner capability for normal users.

The schema subset is `object`, `array`, `string`, `number`, `integer`, `boolean`, `properties`,
`required`, `additionalProperties: false`, `enum`, `minLength`, `maxLength`, `minItems`,
`maxItems`, `pattern`, and `items`. Object schemas must close `additionalProperties`, including
nested objects. Tool results must be small and model-safe.

To make an integration loadable, add its id and entry URL to the central
`integrations/registry.js` allowlist, then enable the id in `capabilityModules` and use the owner
command `#ai reload`. Reload remains atomic.
