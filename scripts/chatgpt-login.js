// Signs the bot in with ChatGPT and saves credentials to chatgpt.credentialsFile.
// Usage (from the Yunzai root): node plugins/pawpilot-plugin/scripts/chatgpt-login.js [--port 1455]
import http from 'node:http'
import {
  DEFAULT_CREDENTIALS_FILE,
  completeAuthorization,
  createAuthorization,
  expandHome,
  readCredentials,
  writeCredentials
} from '../lib/chatgpt-auth.js'
import { getAgentConfig } from '../lib/config.js'

const LOGIN_TIMEOUT_MS = 15 * 60_000

const portIndex = process.argv.indexOf('--port')
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 1455
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('Invalid --port value')
  process.exit(1)
}

const configured = getAgentConfig().chatgpt?.credentialsFile
const file = expandHome(typeof configured === 'string' && configured ? configured : DEFAULT_CREDENTIALS_FILE)
const redirectUri = `http://127.0.0.1:${port}/auth/callback`
const authorization = createAuthorization({ redirectUri, saved: readCredentials(file) })

const server = http.createServer(async (request, response) => {
  const callback = new URL(request.url, redirectUri)
  if (callback.pathname !== '/auth/callback') {
    response.writeHead(404).end()
    return
  }
  const reply = (status, text) => {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text)
    server.close()
  }
  try {
    const record = await completeAuthorization(authorization, callback.searchParams)
    writeCredentials(file, record)
    console.log(`Signed in as ${record.email ?? 'unknown'}; credentials saved to ${file}`)
    reply(200, '登录成功，可以关闭此页面。')
  } catch (error) {
    console.error(`Sign-in failed (${error.code ?? 'UNKNOWN'}): ${error.message}`)
    process.exitCode = 1
    reply(400, `登录失败：${error.message}`)
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log('Open this URL in a browser on this machine (or forward the port over SSH):')
  console.log(authorization.url)
})
setTimeout(() => {
  console.error('Sign-in timed out')
  process.exit(1)
}, LOGIN_TIMEOUT_MS).unref()
