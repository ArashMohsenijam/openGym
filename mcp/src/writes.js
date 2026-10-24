/* What the write tools do to a profile, as pure functions on a state object.

   Every function here takes the profile's document `S` (already a private copy: remote.js hands
   each mutation a fresh clone of what the server holds), changes it in place, and returns a short
   description of what it did. Nothing here reads the disk or the network, so the whole write path
   is testable without a server.

   Routines go in through the app's own plan-file import (lib/plan-share.js): the tool input is
   turned into a plan bundle, parsePlan validates and clamps it exactly as it would a file shared
   from another phone, and mergePlan adds it with fresh ids. A routine Claude creates is therefore
   the routine "Plan → Import a plan file" would have created from the same description, and every
   rule that import enforces (exercise ids that resolve, rest and warm-up clamps, superset names)
   applies here without being restated. */
import { parsePlan, mergePlan } from '../../frontend/src/lib/plan-share.js'
import { EXDB, EXIDX, canonicalExId, BODYPARTS } from '../../frontend/src/lib/exercises.js'
import { exLine } from '../../frontend/src/lib/history.js'
import { convertWeight, convertBodyWeight } from '../../frontend/src/lib/units.js'
import { MUSCLES } from '../../frontend/src/lib/muscles.js'
import { SG_NAME_MAX } from '../../frontend/src/lib/superset-meta.js'
import { scheduleModeOf } from '../../frontend/src/lib/rotation.js'
import { uid } from '../../frontend/src/lib/format.js'
import {
  MEASUREMENT_KEYS, normalizeMeasurementEntry, fromMeasurementDisplay
} from '../../frontend/src/lib/measurements.js'

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']   // index = getDay()
export { BODYPARTS, MUSCLES, MEASUREMENT_KEYS }

const fail = (code, message) => Object.assign(new Error(message), { code })
const unitOf = S => (S.unit === 'lb' ? 'lb' : 'kg')
const customsOf = S => (Array.isArray(S.customEx) ? S.customEx : [])
const localIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

/* ---------- finding exercises ---------- */

const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)

/** Library and custom exercises whose name holds every word of `query`, best match first. */
export function findExercises(query, S = {}, { limit = 10, equipment = null } = {}) {
  const q = words(query)
  if (!q.length) return []
  const eq = equipment ? String(equipment).toLowerCase() : null
  const pool = [...customsOf(S).map(c => ({ ...c, custom: true })), ...EXDB]
  const scored = []
  for (const ex of pool) {
    if (eq && String(ex.eq || '').toLowerCase() !== eq) continue
    const name = words(ex.n)
    if (!q.every(w => name.some(n => n.startsWith(w)))) continue
    const joined = name.join(' ')
    const exact = joined === q.join(' ')
    // Exact name first, then names that start with the query, then the shortest (the plain
    // "barbell bench press" before "barbell bench press with resistance band v. 2").
    const score = (exact ? 0 : joined.startsWith(q.join(' ')) ? 1 : 2) * 1000 + name.length * 10 + (ex.custom ? 0 : 1)
    scored.push({ score, ex })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, Math.max(1, Math.min(50, limit))).map(({ ex }) => ({
    id: ex.id,
    name: ex.n,
    equipment: ex.eq || null,
    body_part: ex.bp || null,
    target: ex.tg || null,
    category: ex.cat || null,
    ...(ex.custom ? { custom: true } : {})
  }))
}

/* ---------- routines ---------- */

// One exercise of the tool input → { id, cfg } where cfg is the routine-exercise shape the plan
// file carries (lib/plan-share.js cleanEx). `customs` collects the custom exercises the bundle
// has to carry so parsePlan can resolve them.
function exerciseCfg(item, S, customs, groups) {
  const id = resolveExercise(item, S, customs)
  const cfg = { id, sets: item.sets }
  if (item.seconds != null) {
    cfg.mode = 'time'
    cfg.sec = item.seconds
  } else if (item.minutes != null) {
    cfg.mode = 'cardio'
    cfg.min = item.minutes
    if (item.speed != null) cfg.speed = item.speed
  } else if (item.reps_min != null || item.reps_max != null) {
    // A rep range is double progression's: the app stores it as `repsMin`..`reps`, the top of the
    // range in `reps` (lib/history.js hasRange), and climbs it before adding weight.
    if (item.reps_min == null || item.reps_max == null) throw fail('EINVAL', 'a rep range needs both reps_min and reps_max')
    if (item.reps_min >= item.reps_max) throw fail('EINVAL', `reps_min (${item.reps_min}) must be below reps_max (${item.reps_max})`)
    cfg.repsMin = item.reps_min
    cfg.reps = item.reps_max
    cfg.prog = item.progression || 'double'
  } else {
    if (item.reps == null) throw fail('EINVAL', `exercise "${item.exercise_name || item.exercise_id || item.custom?.name}": give reps (or reps_min and reps_max), seconds for a timed exercise, or minutes for cardio`)
    cfg.reps = item.reps
  }
  if (item.progression && !cfg.prog) cfg.prog = item.progression
  if (item.weight != null) cfg.weight = convertWeight(item.weight, item.weight_unit || unitOf(S), unitOf(S))
  if (item.rest_sec != null && item.rest_sec > 0) cfg.restSec = item.rest_sec
  if (item.superset) {
    const label = String(item.superset).trim().slice(0, SG_NAME_MAX)
    if (!groups.has(label)) groups.set(label, { sg: 'sg' + uid() })
    cfg.sg = groups.get(label).sg
    cfg.sgName = label
    if (item.superset_rest_sec != null && item.superset_rest_sec > 0) cfg.sgRest = item.superset_rest_sec
  }
  return cfg
}

function resolveExercise(item, S, customs) {
  const given = [item.exercise_id, item.exercise_name, item.custom].filter(v => v != null).length
  if (given !== 1) throw fail('EINVAL', 'each exercise needs exactly one of exercise_id, exercise_name or custom')
  if (item.custom) {
    const c = item.custom
    if (!BODYPARTS.includes(c.body_part)) throw fail('EINVAL', `custom exercise "${c.name}": body_part must be one of ${BODYPARTS.join(', ')}`)
    const id = 'mcp_custom_' + customs.length
    customs.push({
      id, n: String(c.name).trim().slice(0, 80), bp: c.body_part,
      ...(c.equipment ? { eq: c.equipment } : {}),
      ...(c.description ? { desc: c.description } : {}),
      ...(c.primary_muscles?.length ? { primaries: c.primary_muscles } : {}),
      ...(c.secondary_muscles?.length ? { secondaries: c.secondary_muscles } : {})
    })
    return id
  }
  if (item.exercise_id != null) {
    const own = customsOf(S).find(c => c.id === item.exercise_id)
    if (own) return carryCustom(own, customs)
    const id = canonicalExId(item.exercise_id)
    if (EXIDX[id]) return id
    throw fail('ENOENT', `no exercise with id ${JSON.stringify(item.exercise_id)} — use find_exercise to look one up`)
  }
  const want = words(item.exercise_name).join(' ')
  const own = customsOf(S).find(c => words(c.n).join(' ') === want)
  if (own) return carryCustom(own, customs)
  const lib = EXDB.find(e => words(e.n).join(' ') === want)
  if (lib) return lib.id
  const close = findExercises(item.exercise_name, S, { limit: 5 }).map(e => `${e.name} (${e.id})`)
  throw fail('ENOENT', `no exercise named ${JSON.stringify(item.exercise_name)}` +
    (close.length ? `. Closest matches: ${close.join('; ')}` : '. Use find_exercise to search the library, or pass `custom` to create one'))
}

// A custom exercise the profile already has rides in the bundle under its own id, so parsePlan
// resolves it and mergePlan maps it back onto the existing one (same name and body part) instead
// of making a duplicate.
function carryCustom(own, customs) {
  if (!customs.some(c => c.id === own.id)) {
    customs.push({
      id: own.id, n: own.n, bp: own.bp,
      ...(own.eq ? { eq: own.eq } : {}),
      ...(own.desc ? { desc: own.desc } : {}),
      ...(Array.isArray(own.primaries) && own.primaries.length ? { primaries: own.primaries } : {}),
      ...(Array.isArray(own.secondaries) && own.secondaries.length ? { secondaries: own.secondaries } : {})
    })
  }
  return own.id
}

// The members of a superset follow one another in the routine; the app reads a group as a run
// of neighbours sharing `sg`, so a label that comes back after another exercise would be two
// groups wearing one name.
function checkSupersets(items) {
  const seen = new Set()
  let prev = null
  for (const it of items) {
    const label = it.superset ? String(it.superset).trim().slice(0, SG_NAME_MAX) : null
    if (label && label !== prev && seen.has(label)) {
      throw fail('EINVAL', `superset "${label}": its exercises must be listed one after another`)
    }
    if (label) seen.add(label)
    prev = label
  }
}

// The exercise list → routine-exercise configs, through parsePlan and mergePlan: a scratch
// routine is merged into S (adding any new custom exercise to the profile), its exercises taken,
// and the scratch routine removed again.
function buildExercises(S, items, name = 'scratch', emoji = undefined) {
  checkSupersets(items)
  const customs = []
  const groups = new Map()
  const ex = items.map(it => exerciseCfg(it, S, customs, groups))
  const bundle = { opengym_plan: 1, unit: unitOf(S), week: {}, routines: [{ id: 'new', name, emoji, ex }], customEx: customs }
  const parsed = parsePlan(JSON.stringify(bundle), unitOf(S))
  if (parsed.dropped) throw fail('EINVAL', `${parsed.dropped} exercise(s) did not resolve`)
  if (!Array.isArray(S.routines)) S.routines = []
  if (!S.week || typeof S.week !== 'object') S.week = {}
  mergePlan(S, parsed)
  return S.routines[S.routines.length - 1]
}

function routineView(r, S) {
  return {
    routine_id: r.id,
    name: r.name,
    emoji: r.emoji || null,
    exercises: (r.ex || []).map(e => {
      const ex = customsOf(S).find(c => c.id === e.id) || EXIDX[e.id] || { n: e.id }
      return `${ex.n}: ${exLine(e, unitOf(S))}${e.sgName ? ` [superset: ${e.sgName}]` : ''}`
    })
  }
}

function scheduleNote(S) {
  return scheduleModeOf(S) === 'rotation'
    ? 'This profile plans by rotation, not by weekday, so the weekday plan only takes effect once Plan is switched to "Fixed week".'
    : null
}

function addToDays(S, routineId, days) {
  for (const day of days) {
    const k = DAY_KEYS.indexOf(day)
    const cur = [].concat(S.week[k] ?? []).filter(Boolean)
    if (!cur.includes(routineId)) S.week[k] = [...cur, routineId]
  }
}

/** create_routine: a new routine, optionally scheduled on weekdays (added beside what is there). */
export function createRoutine(S, { name, emoji, exercises, days = [] }) {
  const r = buildExercises(S, exercises, String(name).trim().slice(0, 60), emoji)
  if (days.length) addToDays(S, r.id, days)
  const note = days.length ? scheduleNote(S) : null
  return { ...routineView(r, S), scheduled_on: days, ...(note ? { note } : {}) }
}

/** update_routine: rename it, and/or replace its whole exercise list. */
export function updateRoutine(S, { routine_id, name, emoji, exercises }) {
  const r = (S.routines || []).find(x => x.id === routine_id)
  if (!r) throw fail('ENOENT', `no routine with id ${JSON.stringify(routine_id)} — use list_routines`)
  if (name == null && emoji == null && exercises == null) throw fail('EINVAL', 'nothing to change: give name, emoji or exercises')
  if (exercises) {
    const scratch = buildExercises(S, exercises)
    S.routines = S.routines.filter(x => x !== scratch)
    r.ex = scratch.ex
  }
  if (name != null) r.name = String(name).trim().slice(0, 60)
  if (emoji != null) r.emoji = emoji
  return routineView(r, S)
}

/** set_week_plan: which routines each listed weekday holds; [] makes it a rest day. */
export function setWeekPlan(S, { days }) {
  if (!S.week || typeof S.week !== 'object') S.week = {}
  const ids = new Set((S.routines || []).map(r => r.id))
  const changed = {}
  for (const [day, list] of Object.entries(days)) {
    const k = DAY_KEYS.indexOf(day)
    if (k < 0) throw fail('EINVAL', `unknown day ${JSON.stringify(day)} — use ${DAY_KEYS.join(', ')}`)
    const missing = list.filter(id => !ids.has(id))
    if (missing.length) throw fail('ENOENT', `no routine with id ${missing.map(m => JSON.stringify(m)).join(', ')} — use list_routines`)
    if (list.length) S.week[k] = [...new Set(list)]
    else delete S.week[k]
    changed[day] = list.map(id => S.routines.find(r => r.id === id).name)
  }
  const note = scheduleNote(S)
  return { days: changed, ...(note ? { note } : {}) }
}

/* ---------- body ---------- */

/** add_bodyweight: one weigh-in; a second one on the same day replaces it, as in the app. */
export function addBodyweight(S, { weight, unit, date }, now = Date.now()) {
  const d = date || localIso(new Date(now))
  const w = Math.round(Number(convertBodyWeight(weight, unit || unitOf(S), unitOf(S))) * 10) / 10
  if (!(w > 0)) throw fail('EINVAL', 'weight must be above zero')
  if (!Array.isArray(S.bodyweight)) S.bodyweight = []
  const ex = S.bodyweight.find(b => b.d === d)
  const replaced = ex ? ex.w : null
  if (ex) { ex.w = w; ex.t = now } else S.bodyweight.push({ d, w, t: now })
  S.bodyweight.sort((a, b) => (a.d < b.d ? -1 : 1))
  return { date: d, weight: w, unit: unitOf(S), ...(replaced != null ? { replaced } : {}) }
}

/** add_measurements: tape measurements (and body fat) for a day, merged into that day's entry. */
export function addMeasurements(S, { values, unit = 'cm', date }, now = Date.now()) {
  const d = date || localIso(new Date(now))
  const keys = Object.keys(values)
  if (!keys.length) throw fail('EINVAL', 'give at least one measurement')
  const bad = keys.filter(k => !MEASUREMENT_KEYS.includes(k))
  if (bad.length) throw fail('EINVAL', `unknown measurement ${bad.join(', ')} — use ${MEASUREMENT_KEYS.join(', ')}`)
  if (!Array.isArray(S.measurements)) S.measurements = []
  const custom = Array.isArray(S.customMeasurements) ? S.customMeasurements : []
  const at = S.measurements.findIndex(e => e && e.d === d)
  const prev = at >= 0 ? S.measurements[at] : { d }
  const next = { ...prev, d, t: now }
  // Stored in centimetres whatever the profile's unit (lib/measurements.js); body fat is a percent.
  for (const k of keys) next[k] = k === 'bodyFat' ? Number(values[k]) : fromMeasurementDisplay(values[k], unit === 'in' ? 'lb' : 'kg')
  const entry = normalizeMeasurementEntry(next, custom)
  if (at >= 0) S.measurements[at] = entry
  else S.measurements.push(entry)
  S.measurements.sort((a, b) => a.d.localeCompare(b.d))
  const saved = Object.fromEntries(keys.map(k => [k, entry[k]]))
  return { date: d, unit: 'cm', values: saved }
}
