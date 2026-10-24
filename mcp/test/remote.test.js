// The write path end to end, against the real api: api/server.js in a child with its own data
// directory, a profile paired the way the app pairs a phone (a code minted by a signed-in session,
// redeemed for a bearer token), and the MCP server itself driven over stdio by the SDK's client.
// What is checked is what a phone would see on its next sync: the document on the server, its
// revision, and the server's stamp on what this writer changed.
//
// Needs the api's own dependencies (cd api && npm ci --omit=optional), like api's test suite.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createRemote } from '../src/remote.js'
import { boundPort } from '../../api/test/helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const API = path.join(HERE, '..', '..', 'api')
const MCP_ENTRY = path.join(HERE, '..', 'src', 'index.js')
const SECRET = crypto.randomBytes(32).toString('hex')
const UID = 'u_mcp_1'

function cookieFor(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`
  return 'gymsid=' + payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
}

let child, api, dataDir, tmp
const log = { text: '' }

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-remote-'))
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-token-'))
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 })
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: UID, name: 'Arash', created: new Date().toISOString() }], creds: [], subs: [], invites: []
  }))
  child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  })
  child.stdout.on('data', d => { log.text += d })
  child.stderr.on('data', d => { log.text += d })
  api = `http://127.0.0.1:${await boundPort(child, () => log.text)}`
}, 30000)

afterAll(() => {
  child?.kill('SIGKILL')
  for (const d of [dataDir, tmp]) if (d) fs.rmSync(d, { recursive: true, force: true })
})

// The signed-in browser's side: mint a pairing code, read and write the profile.
const browser = {
  async pairCode() {
    const r = await fetch(`${api}/api/pair/create`, { method: 'POST', headers: { Cookie: cookieFor(UID), 'Content-Type': 'application/json' }, body: '{}' })
    return (await r.json()).code
  },
  async get() {
    const r = await fetch(`${api}/api/data`, { headers: { Cookie: cookieFor(UID) } })
    return r.json()
  },
  async put(state, baseRev) {
    const r = await fetch(`${api}/api/data`, { method: 'PUT', headers: { Cookie: cookieFor(UID), 'Content-Type': 'application/json' }, body: JSON.stringify({ state, baseRev }) })
    return r.json()
  }
}

describe('remote.js against the api', () => {
  test('pairing stores a token only this user can read; the token names the profile', async () => {
    const tokenFile = path.join(tmp, 'a', 'token')
    const remote = createRemote({ url: api, tokenFile })
    const user = await remote.pair(await browser.pairCode())
    expect(user).toMatchObject({ id: UID, name: 'Arash' })
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600)
    expect((await remote.me()).id).toBe(UID)
  })

  test('a used or wrong code is refused, and a bad token says to pair again', async () => {
    const remote = createRemote({ url: api, tokenFile: path.join(tmp, 'b', 'token') })
    await expect(remote.pair('WRONG1')).rejects.toThrow(/invalid or expired code/)
    await expect(remote.me()).rejects.toMatchObject({ code: 'EAUTH' })
    fs.mkdirSync(path.join(tmp, 'b'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'b', 'token'), 'not-a-token')
    await expect(remote.me()).rejects.toThrow(/pair again/)
  })

  test('a write on a profile that never synced creates the document', async () => {
    const remote = createRemote({ url: api, tokenFile: path.join(tmp, 'a', 'token') })
    expect((await browser.get()).state).toBe(null)
    const { rev } = await remote.write(S => { S.bodyweight.push({ d: '2026-10-20', w: 80, t: 1 }) })
    expect(rev).toBe(1)
    expect((await browser.get()).state.bodyweight).toEqual([{ d: '2026-10-20', w: 80, t: 1 }])
  })

  test('a device that writes in between is not overwritten: the change is redone on its copy', async () => {
    const tokenFile = path.join(tmp, 'a', 'token')
    let raced = false
    // Between this writer's read and its write, the phone saves a routine of its own.
    const racingFetch = async (url, init = {}) => {
      if (!raced && init.method === 'PUT') {
        raced = true
        const cur = await browser.get()
        await browser.put({ ...cur.state, routines: [...(cur.state.routines || []), { id: 'phone1', name: 'From the phone', ex: [] }] }, cur.rev)
      }
      return fetch(url, init)
    }
    const remote = createRemote({ url: api, tokenFile, fetch: racingFetch })
    let calls = 0
    await remote.write(S => { calls++; S.routines.push({ id: 'mcp1', name: 'From Claude', ex: [] }) })
    expect(calls).toBe(2)
    const names = (await browser.get()).state.routines.map(r => r.name)
    expect(names).toEqual(['From the phone', 'From Claude'])
  })
})

describe('the MCP server over stdio, in remote mode', () => {
  let client
  beforeAll(async () => {
    const tokenFile = path.join(tmp, 'mcp', 'token')
    await createRemote({ url: api, tokenFile }).pair(await browser.pairCode())
    client = new Client({ name: 'test', version: '1' })
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [MCP_ENTRY],
      env: { ...process.env, OPENGYM_URL: api, OPENGYM_TOKEN_FILE: tokenFile },
      stderr: 'ignore'
    }))
  }, 30000)
  afterAll(async () => { await client?.close() })

  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args })
    const text = r.content[0].text
    return { error: !!r.isError, text, json: r.isError ? null : JSON.parse(text) }
  }

  test('lists the read and the write tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    for (const n of ['find_exercise', 'list_routines', 'get_routine', 'create_routine', 'update_routine', 'set_week_plan', 'add_bodyweight', 'add_measurements', 'log_workout']) {
      expect(names).toContain(n)
    }
  })

  test('create_routine saves to the server, stamped, and the read tools see it at once', async () => {
    const before = await browser.get()
    const r = await call('create_routine', {
      name: 'Boxing conditioning', emoji: '🥊', days: ['tue'],
      exercises: [
        { exercise_name: 'plyo push up', sets: 3, seconds: 60, superset: 'Circuit', superset_rest_sec: 90 },
        { exercise_name: 'jump rope', sets: 3, seconds: 60, superset: 'Circuit', superset_rest_sec: 90 }
      ]
    })
    expect(r.error).toBe(false)
    expect(r.json).toMatchObject({ saved: true, name: 'Boxing conditioning', scheduled_on: ['tue'] })
    const after = await browser.get()
    expect(after.rev).toBeGreaterThan(before.rev)
    const made = after.state.routines.find(x => x.id === r.json.routine_id)
    expect(made.ex.map(e => e.id)).toEqual(['1306', '2612'])
    // The server stamped it (api/sync-stamps.js), so a phone merging later keeps it.
    expect(made._ts).toBeGreaterThan(0)
    expect(after.state.week[2]).toEqual([r.json.routine_id])
    const listed = await call('list_routines', {})
    expect(JSON.stringify(listed.json)).toContain('Boxing conditioning')
  })

  test('a refused write explains itself and saves nothing', async () => {
    const before = await browser.get()
    const r = await call('create_routine', { name: 'x', exercises: [{ exercise_name: 'bench pres', sets: 3, reps: 5 }] })
    expect(r.error).toBe(true)
    expect(r.text).toMatch(/^ENOENT: no exercise named "bench pres"\. Closest matches/)
    expect((await browser.get()).rev).toBe(before.rev)
  })

  test('add_bodyweight and add_measurements land in the profile', async () => {
    expect((await call('add_bodyweight', { weight: 81.4, date: '2026-10-23' })).json).toMatchObject({ saved: true, weight: 81.4, unit: 'kg' })
    expect((await call('add_measurements', { values: { waist: 86, bodyFat: 18.5 }, date: '2026-10-23' })).json.saved).toBe(true)
    const S = (await browser.get()).state
    expect(S.bodyweight.find(b => b.d === '2026-10-23').w).toBe(81.4)
    expect(S.measurements.find(m => m.d === '2026-10-23')).toMatchObject({ waist: 86, bodyFat: 18.5 })
  })
})

describe('log_workout over stdio', () => {
  let client
  beforeAll(async () => {
    const tokenFile = path.join(tmp, 'mcp2', 'token')
    await createRemote({ url: api, tokenFile }).pair(await browser.pairCode())
    client = new Client({ name: 'test', version: '1' })
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [MCP_ENTRY],
      env: { ...process.env, OPENGYM_URL: api, OPENGYM_TOKEN_FILE: tokenFile },
      stderr: 'ignore'
    }))
  }, 30000)
  afterAll(async () => { await client?.close() })

  test('a session described to Claude lands in the history, stamped, and the read tools see it', async () => {
    const r = await client.callTool({ name: 'log_workout', arguments: {
      date: '2026-10-22', duration_min: 45,
      exercises: [{ exercise_name: 'barbell bench press', sets: [{ reps: 8, weight: 60 }, { reps: 8, weight: 60 }] }]
    } })
    expect(r.isError).toBeFalsy()
    const out = JSON.parse(r.content[0].text)
    expect(out).toMatchObject({ saved: true, date: '2026-10-22', name: 'Freestyle', duration_min: 45, volume: 960 })
    const w = (await browser.get()).state.workouts.find(x => x.id === out.workout_id)
    expect(w.entries[0].sets).toEqual([{ done: true, w: 60, r: 8 }, { done: true, w: 60, r: 8 }])
    expect(w._ts).toBeGreaterThan(0)
    const listed = await client.callTool({ name: 'get_workout', arguments: { workout_id: out.workout_id } })
    expect(listed.isError).toBeFalsy()
  })
})

describe('the MCP server in local mode', () => {
  test('write tools are refused with how to enable them', async () => {
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [MCP_ENTRY],
      env: { ...process.env, OPENGYM_DATA: dataDir, OPENGYM_UID: UID, OPENGYM_URL: '' },
      stderr: 'ignore'
    }))
    try {
      const r = await client.callTool({ name: 'add_bodyweight', arguments: { weight: 80 } })
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toMatch(/^EREADONLY: .*OPENGYM_URL/)
    } finally { await client.close() }
  }, 30000)
})
