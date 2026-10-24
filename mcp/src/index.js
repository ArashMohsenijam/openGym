#!/usr/bin/env node
/* openGym MCP server — stdio transport. The LLM client (Claude Desktop, Cursor, …) spawns
   this process locally, talks JSON-RPC over stdin/stdout, tears it down when the session ends.

   Two modes:
   - local (OPENGYM_DATA): reads ./data on this box. Read-only, no network, no extra container.
   - remote (OPENGYM_URL): talks to the openGym api as a paired device. Reads what the server
     holds, and the write tools (create_routine, add_bodyweight, …) save through the same sync the
     phone uses. Pair once with `opengym-mcp pair <code>`. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TOOLS } from './tools.js'
import { WRITE_TOOLS } from './write-tools.js'
import { init, getUser, useRemote, setRemoteState } from './state.js'
import { remoteConfig, createRemote } from './remote.js'

const config = remoteConfig()
const remote = config.url ? createRemote(config) : null

// `opengym-mcp pair <code>`: trade the code from Settings → Pair the mobile app for a token.
if (process.argv[2] === 'pair') {
  try {
    if (!remote) throw new Error('set OPENGYM_URL to the address you open openGym at, e.g. OPENGYM_URL=https://gym.example.com')
    if (!process.argv[3]) throw new Error('usage: opengym-mcp pair <code>  (the code from Settings → Pair the mobile app)')
    const user = await remote.pair(process.argv[3])
    console.log(`Paired with ${remote.url} as ${user?.name || 'your profile'}. Token saved to ${config.tokenFile}.`)
    process.exit(0)
  } catch (e) {
    console.error(`pairing failed: ${e.message}`)
    process.exit(1)
  }
}

const server = new McpServer({
  name: 'opengym',
  version: '0.2.0'
})

// Fail fast on bad config so a misnamed OPENGYM_DATA doesn't silently answer every call with
// the no-state sentinel. Always register every tool so the LLM sees the full list at
// handshake, even when state didn't resolve.
let connected = false
async function connect() {
  if (connected) return
  if (remote) {
    useRemote(await remote.me())
  } else {
    init()
  }
  connected = true
}
try {
  await connect()
  const u = getUser()
  console.error(`[opengym-mcp] serving profile ${u.name} (${u.id})${remote ? ` from ${remote.url}` : ''}`)
} catch (e) {
  console.error(`[opengym-mcp] ${e.message}`)
  // Don't exit — keep the tool listings up so the user sees a useful error after fixing their
  // env and restarting.
}

const reply = result => ({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
const replyError = err => ({ isError: true, content: [{ type: 'text', text: `${err.code || 'ERROR'}: ${err.message}` }] })

for (const t of TOOLS) {
  server.tool(t.name, t.description, t.schema, async (params) => {
    try {
      await connect()
      // Remote mode answers from what the server holds now, not from a copy read at start-up.
      if (remote) setRemoteState((await remote.pull()).state)
      return reply(t.handler(params || {}))
    } catch (err) {
      return replyError(err)
    }
  })
}

for (const t of WRITE_TOOLS) {
  server.tool(t.name, t.description, t.schema, async (params) => {
    try {
      if (!remote) {
        throw Object.assign(new Error('this openGym MCP server is read-only: writing needs OPENGYM_URL (and `opengym-mcp pair <code>`), so changes go through the openGym server and reach your devices'), { code: 'EREADONLY' })
      }
      await connect()
      const { result, state } = await remote.write(S => t.apply(S, params || {}))
      setRemoteState(state)
      return reply({ saved: true, ...result })
    } catch (err) {
      return replyError(err)
    }
  })
}

const transport = new StdioServerTransport()
await server.connect(transport)
// Process stays alive serving JSON-RPC over stdio until the LLM client disconnects.
