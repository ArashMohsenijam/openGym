/* Remote mode: the MCP server as a paired device of an openGym instance.

   Reading ./data straight off the disk (state.js) is fine for answering questions, but a write
   that went round the api would race every phone's sync: the server keeps a revision per profile,
   stamps what each writer changed and merges devices against it, and none of that runs for a file
   edited behind its back. So writes go through the same door the phone app uses — GET /api/data,
   change the document, PUT /api/data with the revision it was read at — and a 409 (some device
   wrote in between) means read again and redo the change on the newer copy. The server stamps the
   change itself, because this writer does not (api/sync-stamps.js, "an API client"), so a phone
   that merges later keeps it.

   The credential is the same bearer token a paired phone holds: minted from a one-time code the
   app shows under Settings → Pair the mobile app (`opengym-mcp pair <code>`), renewed through
   GET /api/me past half its life, ended by "Sign out everywhere". It lives in a file of its own,
   readable by this user only, and never appears in a tool result. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fail = (code, message) => Object.assign(new Error(message), { code })

export function remoteConfig(env = process.env) {
  const url = String(env.OPENGYM_URL || '').trim().replace(/\/+$/, '')
  const tokenFile = env.OPENGYM_TOKEN_FILE || path.join(os.homedir(), '.config', 'opengym-mcp', 'token')
  return { url, tokenFile }
}

export function readToken(tokenFile) {
  try { return fs.readFileSync(tokenFile, 'utf8').trim() || null } catch { return null }
}

export function saveToken(tokenFile, token) {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 })
  const tmp = tokenFile + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 })
  fs.renameSync(tmp, tokenFile)
}

export function createRemote({ url, tokenFile, fetch = globalThis.fetch }) {
  if (!/^https?:\/\//.test(url)) throw fail('EINVAL', 'OPENGYM_URL must be the address you open openGym at, e.g. https://gym.example.com')

  async function call(method, p, body, token = readToken(tokenFile)) {
    if (!token && p !== '/api/pair/redeem') {
      throw fail('EAUTH', 'not paired with the openGym server yet: in the app open Settings → Pair the mobile app, then run `opengym-mcp pair <code>`')
    }
    let res
    try {
      res = await fetch(url + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
    } catch (e) {
      throw fail('ENET', `cannot reach ${url}: ${e.cause?.code || e.message}`)
    }
    let data = null
    try { data = await res.json() } catch { /* an HTML error page from a proxy */ }
    if (res.status === 401) throw fail('EAUTH', 'the openGym server no longer accepts this pairing (expired, or signed out everywhere) — pair again with `opengym-mcp pair <code>`')
    return { status: res.status, data }
  }

  let renewed = false
  return {
    url,
    /** Trade a code from Settings → Pair the mobile app for a token, and keep it. */
    async pair(code) {
      const { status, data } = await call('POST', '/api/pair/redeem', { code: String(code).trim().toUpperCase() }, null)
      if (status !== 200 || !data?.token) throw fail('EAUTH', data?.error || `pairing failed (HTTP ${status})`)
      saveToken(tokenFile, data.token)
      return data.user
    },
    /** Who the token belongs to; swaps in the renewed token the server hands out past half-life. */
    async me() {
      const { status, data } = await call('GET', '/api/me')
      if (status !== 200) throw fail('EREMOTE', data?.error || `GET /api/me answered ${status}`)
      if (data.token && !renewed) { saveToken(tokenFile, data.token); renewed = true }
      return data.user
    },
    async pull() {
      const { status, data } = await call('GET', '/api/data')
      if (status !== 200) throw fail('EREMOTE', data?.error || `GET /api/data answered ${status}`)
      return { state: data.state || null, rev: data.rev || 0 }
    },
    /**
     * Read the profile, apply `mutate` to a copy, write it back over the revision it was read at.
     * On a conflict the change is redone on the newer document. `mutate` must be deterministic in
     * what it is given (a fresh copy each time) — the pure functions in writes.js are.
     */
    async write(mutate, { attempts = 4 } = {}) {
      for (let i = 0; i < attempts; i++) {
        const { state, rev } = await this.pull()
        const draft = state ? JSON.parse(JSON.stringify(state)) : { unit: 'kg', routines: [], week: {}, bodyweight: [], customEx: [] }
        const result = mutate(draft)
        const { status, data } = await call('PUT', '/api/data', {
          state: draft, baseRev: rev, ...(typeof state?._wid === 'string' ? { baseWid: state._wid } : {})
        })
        if (status === 200) return { result, rev: data.rev, state: draft }
        if (status !== 409) throw fail('EREMOTE', data?.error || `PUT /api/data answered ${status}`)
      }
      throw fail('EBUSY', 'another device kept writing to this profile; nothing was saved — try again')
    }
  }
}
