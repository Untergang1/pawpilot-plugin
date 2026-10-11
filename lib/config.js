import fs from 'node:fs'
import YAML from 'yaml'

const configFile = new URL('../config/config.yaml', import.meta.url)

/** Built-in defaults used when a config value is missing or invalid. */
export const DEFAULTS = Object.freeze({
  maxInputChars: 4000,
  maxToolRounds: 4,
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 6,
  rateLimitMaxConcurrent: 1,
  groupRequestQueueMaxOutstanding: 8,
  conversationHistoryTurns: 24,
  conversationTtlMinutes: 45,
  conversationMaxChars: 12_000,
  conversationHistoryRecoveryMaxMessages: 12,
  groupHistoryRecoveryMaxMessages: 64,
  groupHistoryRecoveryMaxChars: 6000
})

const PROVIDER_DEFAULTS = Object.freeze({
  dashscope: Object.freeze({ requestTimeoutMs: 30_000 }),
  chatgpt: Object.freeze({ requestTimeoutMs: 60_000 })
})

export function positiveInteger (value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function plainObject (value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Applies defaults and type checks so callers can read values directly. */
export function normalizeConfig (raw) {
  raw = plainObject(raw)
  const config = { ...raw }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    config[key] = positiveInteger(raw[key], fallback)
  }
  for (const [provider, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    const section = { ...plainObject(raw[provider]) }
    section.requestTimeoutMs = positiveInteger(section.requestTimeoutMs, defaults.requestTimeoutMs)
    config[provider] = section
  }
  config.provider = raw.provider ?? 'dashscope'
  config.capabilityModules = Array.isArray(raw.capabilityModules) ? raw.capabilityModules : []
  return config
}

let cached = { mtimeMs: -1, config: null }

/** Reads config.yaml, re-parsing only when the file's modification time changes. */
export function getAgentConfig () {
  const { mtimeMs } = fs.statSync(configFile)
  if (mtimeMs !== cached.mtimeMs) {
    cached = { mtimeMs, config: normalizeConfig(YAML.parse(fs.readFileSync(configFile, 'utf8'))) }
  }
  return cached.config
}
