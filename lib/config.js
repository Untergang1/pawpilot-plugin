import fs from 'node:fs'
import YAML from 'yaml'
import { positiveInteger } from './util.js'

const configFile = new URL('../config/config.yaml', import.meta.url)
const templateFile = new URL('../config/config.example.yaml', import.meta.url)

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
  groupHistoryRecoveryMaxChars: 6000,
  conversationSummaryMaxChars: 800,
  imageInputMaxCount: 3,
  imageInputMaxBytes: 5 * 1024 * 1024,
  imageDownloadTimeoutMs: 10_000
})

const PROVIDER_DEFAULTS = Object.freeze({
  dashscope: Object.freeze({ requestTimeoutMs: 30_000 }),
  chatgpt: Object.freeze({ requestTimeoutMs: 60_000 })
})

const SEARCH_STRATEGIES = new Set(['turbo', 'max'])

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
  const { temperature } = config.dashscope
  config.dashscope.temperature = typeof temperature === 'number' && temperature >= 0 && temperature <= 2 ? temperature : 0.7
  // Web search is opt-in per backend; DashScope's agent strategies are billed extra and stay unavailable.
  config.dashscope.webSearch = config.dashscope.webSearch === true
  config.dashscope.searchStrategy = SEARCH_STRATEGIES.has(config.dashscope.searchStrategy) ? config.dashscope.searchStrategy : 'turbo'
  config.chatgpt.webSearch = config.chatgpt.webSearch === true
  const { webSearchMaxSources } = config.chatgpt
  config.chatgpt.webSearchMaxSources = Number.isInteger(webSearchMaxSources) && webSearchMaxSources >= 0 && webSearchMaxSources <= 5
    ? webSearchMaxSources
    : 3
  config.provider = raw.provider ?? 'dashscope'
  config.capabilityModules = Array.isArray(raw.capabilityModules) ? raw.capabilityModules : []
  return config
}

let cached = { mtimeMs: -1, config: null }

/**
 * Reads config.yaml, re-parsing only when the file's modification time changes.
 * The local config is untracked; it is created from config.example.yaml on first read.
 */
export function getAgentConfig () {
  if (!fs.existsSync(configFile)) fs.copyFileSync(templateFile, configFile)
  const { mtimeMs } = fs.statSync(configFile)
  if (mtimeMs !== cached.mtimeMs) {
    cached = { mtimeMs, config: normalizeConfig(YAML.parse(fs.readFileSync(configFile, 'utf8'))) }
  }
  return cached.config
}
