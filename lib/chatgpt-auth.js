import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ModelClientError } from './model-client.js'

// Sign in with ChatGPT, open-source flow: the client is registered dynamically on first
// sign-in, and the issued client ID plus host ID are reused for later sign-ins.
export const API_RESOURCE = 'https://api.openai.com/v1'
const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize'
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token'
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
const AGENT_NAME = 'pawpilot-plugin'
const PLAN_USAGE_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_USAGE_SCOPE}`
const REFRESH_MARGIN_MS = 5 * 60_000

export const DEFAULT_CREDENTIALS_FILE = '~/.pawpilot-chatgpt/credentials.json'

export class ChatGPTAuthError extends ModelClientError {
  constructor (message, code = 'CHATGPT_AUTH_FAILED') {
    super(message, code, { provider: 'chatgpt' })
    this.name = 'ChatGPTAuthError'
  }
}

export function expandHome (file) {
  return file === '~' || file.startsWith('~/') ? path.join(os.homedir(), file.slice(1)) : file
}

function decodeJwtPayload (token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

function parseScopes (scope) {
  return String(scope ?? '').split(/[\s+]+/u).filter(Boolean).sort()
}

export function readCredentials (file) {
  let record
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new ChatGPTAuthError('ChatGPT credentials file is unreadable', 'CREDENTIALS_INVALID')
  }
  if (!record || typeof record.access_token !== 'string' || typeof record.client_id !== 'string') {
    throw new ChatGPTAuthError('ChatGPT credentials file is invalid', 'CREDENTIALS_INVALID')
  }
  return record
}

/** Writes credentials atomically with owner-only permissions. */
export function writeCredentials (file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

async function postToken (fetchImpl, params) {
  let response
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    })
  } catch {
    throw new ChatGPTAuthError('ChatGPT token request could not be sent', 'NETWORK_ERROR')
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const code = response.status === 400 || response.status === 401 ? 'REAUTH_REQUIRED' : 'TOKEN_REQUEST_FAILED'
    throw new ChatGPTAuthError(`ChatGPT token request failed (HTTP ${response.status}, ${body?.error ?? 'unknown'})`, code)
  }
  if (typeof body.access_token !== 'string') {
    throw new ChatGPTAuthError('ChatGPT token response has no access token', 'TOKEN_REQUEST_FAILED')
  }
  return body
}

/**
 * Creates the PKCE authorization request. Pass the saved credentials to reuse the
 * issued client ID and host ID; without them a new client is registered.
 */
export function createAuthorization ({ redirectUri, saved = null }) {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const state = crypto.randomBytes(16).toString('base64url')
  const nonce = crypto.randomBytes(16).toString('base64url')
  const clientId = saved?.client_id ?? DYNAMIC_CLIENT_ID
  const hostId = saved?.ext_agent_host_id ?? `urn:uuid:${crypto.randomUUID()}`
  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    agent_name_hint: AGENT_NAME,
    ext_agent_host_id: hostId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    resource: API_RESOURCE,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    nonce
  }).toString()
  return { url: url.toString(), verifier, state, nonce, clientId, hostId, redirectUri }
}

/** Validates the loopback callback and exchanges the code for a credential record. */
export async function completeAuthorization (authorization, callbackParams, { fetchImpl = fetch } = {}) {
  const error = callbackParams.get('error')
  if (error) throw new ChatGPTAuthError(`Authorization was refused: ${error}`, 'AUTHORIZATION_DENIED')
  if (callbackParams.get('state') !== authorization.state) {
    throw new ChatGPTAuthError('Authorization state mismatch', 'STATE_MISMATCH')
  }
  const clientId = callbackParams.get('client_id') || authorization.clientId
  if (clientId === DYNAMIC_CLIENT_ID) {
    throw new ChatGPTAuthError('Authorization callback did not return an issued client ID', 'CLIENT_NOT_ISSUED')
  }
  const body = await postToken(fetchImpl, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code: callbackParams.get('code') ?? '',
    code_verifier: authorization.verifier,
    redirect_uri: authorization.redirectUri,
    resource: API_RESOURCE
  })
  // The ID token comes straight from the token endpoint over TLS, so its claims are
  // trusted without signature verification; the nonce binds it to this request.
  const claims = decodeJwtPayload(body.id_token)
  if (body.id_token && claims.nonce !== undefined && claims.nonce !== authorization.nonce) {
    throw new ChatGPTAuthError('ID token nonce mismatch', 'STATE_MISMATCH')
  }
  const scopes = parseScopes(body.scope ?? callbackParams.get('scope'))
  if (!scopes.includes(PLAN_USAGE_SCOPE)) {
    throw new ChatGPTAuthError('ChatGPT plan usage was not granted', 'PLAN_USAGE_NOT_GRANTED')
  }
  return {
    email: claims.email,
    issuer: 'https://auth.openai.com',
    subject: claims.sub,
    client_id: clientId,
    ext_agent_host_id: authorization.hostId,
    id_token: body.id_token,
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_type: body.token_type,
    expires_in: body.expires_in,
    scopes,
    saved_at: new Date().toISOString()
  }
}

function accessTokenExpiresAt (record) {
  const exp = decodeJwtPayload(record.access_token).exp
  if (Number.isFinite(exp)) return exp * 1000
  const savedAt = Date.parse(record.saved_at)
  return Number.isFinite(savedAt) && Number.isFinite(record.expires_in) ? savedAt + record.expires_in * 1000 : 0
}

// Refresh tokens rotate, so concurrent requests in this process must share one refresh.
const pendingRefreshes = new Map()

/**
 * Provides a valid access token from the credentials file, refreshing it when it is
 * about to expire. The file is re-read on every call so a new login takes effect
 * without restarting the bot.
 */
export class ChatGPTCredentials {
  constructor ({ file = DEFAULT_CREDENTIALS_FILE, fetchImpl = fetch, now = Date.now } = {}) {
    this.file = expandHome(file)
    this.fetch = fetchImpl
    this.now = now
  }

  #load () {
    const record = readCredentials(this.file)
    if (!record) throw new ChatGPTAuthError('ChatGPT is not signed in', 'NOT_LOGGED_IN')
    return record
  }

  async accessToken ({ forceRefresh = false } = {}) {
    const record = this.#load()
    if (!forceRefresh && accessTokenExpiresAt(record) - this.now() > REFRESH_MARGIN_MS) {
      return record.access_token
    }
    return this.#refresh(record)
  }

  #refresh (record) {
    let pending = pendingRefreshes.get(this.file)
    if (!pending) {
      pending = this.#doRefresh(record).finally(() => pendingRefreshes.delete(this.file))
      pendingRefreshes.set(this.file, pending)
    }
    return pending
  }

  async #doRefresh (record) {
    if (typeof record.refresh_token !== 'string') {
      throw new ChatGPTAuthError('ChatGPT credentials have no refresh token', 'REAUTH_REQUIRED')
    }
    const body = await postToken(this.fetch, {
      grant_type: 'refresh_token',
      client_id: record.client_id,
      refresh_token: record.refresh_token,
      resource: API_RESOURCE
    })
    const next = {
      ...record,
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? record.refresh_token,
      id_token: body.id_token ?? record.id_token,
      expires_in: body.expires_in,
      scopes: body.scope ? parseScopes(body.scope) : record.scopes,
      saved_at: new Date(this.now()).toISOString()
    }
    writeCredentials(this.file, next)
    return next.access_token
  }
}
