/**
 * Central allowlist of pawpilot-plugin-owned capability modules. Add future integrations
 * here; the chatbot core deliberately has no dependency on any individual module.
 */
export const INTEGRATION_MODULES = {
  phi: new URL('./phi/index.js', import.meta.url),
  'glory-of-kings': new URL('./glory-of-kings/index.js', import.meta.url)
}
