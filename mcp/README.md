# openGym MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) bridge that lets an external LLM
application (Claude Desktop, Cursor, Cline, Continue, etc.) read your openGym profile —
routines, workouts, body-weight log, estimated 1RMs, and muscle balance — directly from your
self-hosted `./data` directory.

It runs locally as a stdio process spawned by the LLM client and adds no new container. It has
two modes:

- **Local** (`OPENGYM_DATA`): reads the `state-<uid>.json` files the openGym api writes, straight
  off the disk of the box it runs on. Read-only, no network, no extra authentication.
- **Remote** (`OPENGYM_URL`): talks to your openGym server over HTTPS as a paired device, the
  way the phone app does. It reads what the server holds and can also **write**: create and
  edit routines, set the weekly plan, log workouts, weigh-ins and body measurements. Changes go through the
  same sync as the phone, so they show up on every device. See [Writing to openGym](#writing-to-opengym-remote-mode).

Either way the LLM never sees passkeys, VAPID keys, session secrets or the pairing token.

The numbers it answers with are computed by the **same pure functions the React UI uses**
(`frontend/src/lib/*.js`) — `estimate1RM`, `loadOfWorkouts`, `effectiveRoutine`, etc. — so a
"what's my bench 1RM?" answer matches the Stats screen exactly.

## Quick start

### 1. Install

```bash
cd mcp
npm install
```

### 2. Point it at your data

The MCP server reads the same `./data` directory `docker compose up` creates. Pick the profile
to answer for — its user id is in `./data/db.json` under `users[].id`:

```bash
# single-user instance (the common self-hosted case) — auto-detected:
node src/index.js

# multi-user instance, or just to be explicit:
OPENGYM_UID=<your-uid> OPENGYM_DATA=/path/to/openGym/data node src/index.js
```

### 3. Register with your LLM client

Add the server to your LLM client's MCP config. For Claude Desktop, edit
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
      "env": {
        "OPENGYM_DATA": "/absolute/path/to/openGym/data",
        "OPENGYM_UID": "<your-uid>"   // optional — auto-detected if you have one profile
      }
    }
  }
}
```

For Cursor and other MCP-compatible clients, see the client's MCP docs — the same `command` +
`args` + `env` shape is what every stdio MCP server expects.

Restart the client; you should see the openGym tools appear with "serving profile \<name\>" on
the server's stderr.

## Writing to openGym (remote mode)

Writes go through your openGym server, never round it: a file edited on the disk behind the api
would race every phone's sync. So in remote mode the MCP server is a paired device.

1. **Pair once.** In openGym in a browser (the row is not in the phone app), open **Settings →
   Account → Pair the mobile app**; it shows a code that is valid for 5 minutes. Then, on the machine your LLM client runs on:

   ```bash
   cd mcp && npm install
   OPENGYM_URL=https://gym.example.com node src/index.js pair ABC123
   # Paired with https://gym.example.com as Arash. Token saved to ~/.config/opengym-mcp/token.
   ```

   The token is the same kind the phone app holds: renewed automatically while it is used,
   ended by **Settings → Sign out everywhere**. It is stored readable by your user only
   (`OPENGYM_TOKEN_FILE` to put it elsewhere) and never appears in a tool result.

2. **Point your LLM client at it** with `OPENGYM_URL` instead of `OPENGYM_DATA`:

   ```jsonc
   {
     "mcpServers": {
       "opengym": {
         "command": "node",
         "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
         "env": { "OPENGYM_URL": "https://gym.example.com" }
       }
     }
   }
   ```

Now you can say *"Make me a Tuesday and Friday boxing circuit: barbell push-outs, plyo push-ups and
jump rope, 3 rounds of 60 seconds each, 90 seconds between rounds"* and the routine is in the app
on its next sync. Or, after a session you did not log in the app: *"Log today's push day: bench
4×8 at 80, the last set to failure at 7 reps; overhead press 3×8 at 45; skipped dips"*.

A logged workout goes through the app's own finish path for a session logged after the fact
(`frontend/src/lib/backfill.js`, `finish-workout.js`): the session is built from the history
before its day, as **Log a past workout** builds it, the sets go in ticked, and then
`buildCompletedWorkout`, the edit stamp, date-order filing, PR badges (`rebuildPrHistory`) and the
rotation's next pass run exactly as they do there.

How a write is saved: the server's document is read, the change is applied to it, and it is
written back over the revision it was read at (`PUT /api/data` with `baseRev`). If a phone saved
in between, the server answers 409 and the change is redone on the newer copy, so nothing the
phone did is lost. The server stamps what this writer changed (`api/sync-stamps.js`), so a device
that merges later keeps it. Routines go in through the app's own plan-file import
(`frontend/src/lib/plan-share.js`), so a routine made here is exactly what **Plan → Import a plan
file** would make from the same description.

## Tools

Ten read tools (both modes):

| Tool | What it answers |
|---|---|
| `list_routines` | What routines are saved in my profile? (names + exercise counts) |
| `get_routine` | What does the Push Day routine prescribe? (sets/reps/weight and rest per exercise) |
| `preview_session` | What will the app actually put on screen when I start this routine — after the progression policy and my history have overridden the plan? |
| `get_week_plan` | What's planned when: the next seven days with their routines and how each was decided (coach week, a pinned session, an override, the weekday plan), the current coach week when one is running, and the weekday table. |
| `list_workouts` | Recent sessions — newest first, with dates, sets done/planned, volume, duration, PRs. |
| `get_workout` | Full set-by-set breakdown of one session, by `workout_id` or by date. On a day with two sessions the date alone returns both ids to pick from rather than guessing at one. |
| `get_bodyweight` | Weigh-ins with the latest weight, the goal line, and deltas vs goal. |
| `estimate_1rm` | All-time best 1RM for an exercise + the trend, or a PR table across all exercises. |
| `muscle_balance` | Which muscles I've trained this week/month/all-time, ranked + which I've neglected. |
| `find_exercise` | Search the 1,300+ exercise library and the profile's own exercises by name, for the ids the write tools take. |

Six write tools (remote mode only; in local mode they answer with how to turn them on):

| Tool | What it does |
|---|---|
| `create_routine` | A new routine from a list of exercises: reps, a rep range (double progression), timed sets, cardio minutes, weight, rest, supersets and circuits, custom exercises for what the library lacks. Optionally scheduled on weekdays. |
| `update_routine` | Rename a routine and/or replace its exercise list (read it with `get_routine` first). |
| `set_week_plan` | Which routines each listed weekday holds; an empty list makes a rest day. |
| `add_bodyweight` | A weigh-in (kg or lb), today or a given date; the same day replaces, as in the app. |
| `add_measurements` | Tape measurements (cm or in) and body fat for a day, merged into that day's entry. |
| `log_workout` | A finished session (today or earlier): sets with reps, weight, seconds or minutes, warm-ups, RIR/RPE, failure; following a routine or freestyle. Saved the way the app's **Log a past workout** saves one, so PRs are judged against the history before it and the next session's prescription moves on from it. Can re-log a day (`replace_workout_id`). |

`get_routine` and `preview_session` answer two different questions, and confusing them is the
easiest way for a coach to give wrong advice. `get_routine` reports what the routine *stores*.
`preview_session` reports what the athlete will actually *see*: a routine holding "squat 3×8 @
60 kg" opens at 75 kg if the policy progressed or deloaded from that routine's last logged
session. The routine's own weight is the last fallback the session builder consults, not the
first; its reps hold unless a policy that moves reps moved them, or the profile starts planned
sessions from the last session (`starts_from`). Ask `preview_session` before naming a weight.

Each tool returns JSON the LLM can format as it likes; structured fields (sets, dates, levels)
are pre-formatted into human-readable labels in `src/labels.js` so the LLM doesn't need to
re-interpret them.

## How it reuses the training logic

The MCP server imports the training helpers under `frontend/src/lib/` directly as Node ESM
and calls the same functions the React UI does (`history.js`, `onerm.js`, `muscles.js`,
`exercises.js`). The numbers it returns match what the Stats screen shows, because they are
the same code.

The one lib file that wasn't Node-safe was `i18n.js` (Vite's `import.meta.glob` at module
top level) — split into `i18n-core.js` (pure, Node-safe) + `i18n.js` (Vite/React bits,
re-exports from core). `exercises.js` got a one-line `import.meta.env || {}` guard. No new
dependencies landed in `frontend/`, no public exports changed.

## Design constraints honoured

- **One runtime dependency beyond the MCP SDK:** none. No database driver, no HTTP framework;
  remote mode uses Node's built-in `fetch`.
- **No new container.** stdio transport is spawned by the LLM client; nothing to add to
  `docker-compose.yml`.
- **No new auth.** Local mode: the filesystem is the boundary — same as `docker compose` running
  on the user's box. Remote mode: the pairing code and bearer token the phone app already uses;
  no server change was needed. No passkey material, VAPID keys, or session secrets ever cross it.
- **No telemetry.** Local mode reads `./data/*.json` and makes no network call; remote mode talks
  only to `OPENGYM_URL`. Both exit when the LLM client disconnects.

## Tests

```bash
cd mcp && npm test
```

58 cases seeding state from `frontend/src/lib/demoSeed.js` (the same deterministic fixture
the public demo runs on). Pins JSON shape and the user-facing edge cases: rest-day override,
missing routine, zero-workout history, no synced state, superset links, three 1RM formulas.
"Today" is pinned via `vi.useFakeTimers({ now: ..., toFake: ['Date'] })` so date-dependent
tools see consistent values regardless of when the suite runs. The pure lib functions have
their own 92 tests in `frontend/src/lib/*.test.js`.

## Roadmap

- **Done (Phase 1):** read-only stdio, 8 tools, direct `./data` access.
- **Done (Phase 1.5):** `preview_session` — the policy's next prescription, the opening set
  rows it produces, and which of plan / confirmed weight / history each number came from.
- **Done (Phase 2):** read+write over stdio in remote mode. The pairing token stands in for a
  separate token store, and the api's conditional write (`baseRev`, 409 on conflict) for a
  write-lock. Tools: `create_routine`, `update_routine`, `set_week_plan`, `add_bodyweight`,
  `add_measurements`, `log_workout`, plus `find_exercise`.
- **Next:** `override_day` (move or skip one day's session), per-side (unilateral) sets in
  `log_workout`.
- **Phase 3:** Streamable HTTP transport, opt-in 4th container in `docker-compose.yml`. Same
  tool implementations, second transport — the MCP SDK supports both behind one tool registration.

## License

AGPL-3.0-or-later, same as openGym.
