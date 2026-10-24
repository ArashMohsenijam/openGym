// The write tools' effect on a profile document (src/writes.js), on the demo fixture. Each test
// takes a fresh copy, applies one tool and checks what the app would read back: the routine the
// plan importer would have made, the weekday table, the weigh-in and measurement lists.
import { describe, test, expect, beforeEach } from 'vitest'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { parsePlan, buildPlanBundle } from '../../frontend/src/lib/plan-share.js'
import { buildCombinedEntries } from '../../frontend/src/lib/session-merge.js'
import {
  createRoutine, updateRoutine, setWeekPlan, addBodyweight, addMeasurements, findExercises, logWorkout
} from '../src/writes.js'
import { WRITE_TOOLS } from '../src/write-tools.js'
import { TOOLS } from '../src/tools.js'
import { _seedStateForTests } from '../src/state.js'

let S
beforeEach(() => { S = buildDemoState(); S.unit = 'kg' })

const station = name => ({ exercise_name: name, sets: 3, seconds: 60, superset: 'Boxing circuit', superset_rest_sec: 90 })

describe('find_exercise', () => {
  test('every word of the query starts a word of the name; the plain name first', () => {
    const r = findExercises('plyo push', S, { limit: 3 })
    expect(r[0]).toMatchObject({ id: '1306', name: 'plyo push up', equipment: 'body weight' })
    expect(r.every(x => /plyo/.test(x.name) && /push/.test(x.name))).toBe(true)
  })
  test('the exact name beats longer names that contain it', () => {
    expect(findExercises('barbell bench press', S)[0].id).toBe('0025')
  })
  test('equipment narrows the search, and the profile\'s own exercises are found too', () => {
    expect(findExercises('bench press', S, { equipment: 'dumbbell' }).every(x => x.equipment === 'dumbbell')).toBe(true)
    S.customEx = [{ id: 'c1', n: 'Barbell push-out', bp: 'shoulders', eq: 'barbell', custom: true }]
    expect(findExercises('push out', S)[0]).toMatchObject({ id: 'c1', custom: true })
  })
})

describe('create_routine', () => {
  test('a circuit of library and custom exercises lands as the plan importer would make it', () => {
    const before = S.routines.length
    const r = createRoutine(S, {
      name: 'Boxing conditioning', emoji: '🥊',
      exercises: [
        { custom: { name: 'Barbell push-out', body_part: 'shoulders', equipment: 'barbell', primary_muscles: ['deltoids'] }, sets: 3, seconds: 60, superset: 'Boxing circuit', superset_rest_sec: 90 },
        station('plyo push up'),
        station('jump rope')
      ]
    })
    expect(S.routines.length).toBe(before + 1)
    const made = S.routines.at(-1)
    expect(made).toMatchObject({ id: r.routine_id, name: 'Boxing conditioning', emoji: '🥊' })
    expect(made.ex.map(e => [e.sets, e.mode, e.sec, e.sgName, e.sgRest])).toEqual(Array(3).fill([3, 'time', 60, 'Boxing circuit', 90]))
    expect(new Set(made.ex.map(e => e.sg)).size).toBe(1)
    expect(made.ex.slice(1).map(e => e.id)).toEqual(['1306', '2612'])
    const custom = S.customEx.find(c => c.id === made.ex[0].id)
    expect(custom).toMatchObject({ n: 'Barbell push-out', bp: 'shoulders', eq: 'barbell', custom: true, primaries: ['deltoids'] })
    expect(r.exercises[0]).toBe('Barbell push-out: 3 × 1:00 [superset: Boxing circuit]')
    // And it round-trips through the app's own plan export, nothing dropped.
    const back = parsePlan(JSON.stringify(buildPlanBundle(S)), 'kg')
    expect(back.dropped).toBe(0)
  })

  test('reps, a rep range with double progression, weight in either unit, rest', () => {
    createRoutine(S, {
      name: 'Push', exercises: [
        { exercise_id: '0025', sets: 4, reps_min: 6, reps_max: 8, weight: 60, rest_sec: 120 },
        { exercise_name: 'dumbbell bench press', sets: 3, reps: 10, weight: 50, weight_unit: 'lb' }
      ]
    })
    const [bench, db] = S.routines.at(-1).ex
    expect(bench).toMatchObject({ id: '0025', sets: 4, repsMin: 6, reps: 8, prog: 'double', weight: 60, restSec: 120 })
    expect(db).toMatchObject({ reps: 10, weight: 22.75 })   // 50 lb → kg, rounded to a loadable quarter
  })

  test('scheduled days are added beside what the day already holds', () => {
    const monBefore = [].concat(S.week[1] ?? [])
    const r = createRoutine(S, { name: 'Extra', exercises: [{ exercise_id: '0025', sets: 3, reps: 5 }], days: ['mon', 'sat'] })
    expect(S.week[1]).toEqual([...monBefore, r.routine_id])
    expect(S.week[6]).toEqual([r.routine_id])
    expect(r.scheduled_on).toEqual(['mon', 'sat'])
  })

  test('a custom the profile already has is reused, not duplicated', () => {
    createRoutine(S, { name: 'A', exercises: [{ custom: { name: 'Plate circles', body_part: 'shoulders' }, sets: 3, seconds: 60 }] })
    const n = S.customEx.length
    createRoutine(S, { name: 'B', exercises: [{ exercise_name: 'plate circles', sets: 2, seconds: 45 }] })
    createRoutine(S, { name: 'C', exercises: [{ custom: { name: 'Plate circles', body_part: 'shoulders' }, sets: 2, seconds: 45 }] })
    expect(S.customEx.length).toBe(n)
    const ids = S.routines.slice(-3).map(r => r.ex[0].id)
    expect(new Set(ids).size).toBe(1)
  })

  test('refusals name what to fix and leave the profile alone', () => {
    const snapshot = JSON.stringify(S)
    expect(() => createRoutine(S, { name: 'x', exercises: [{ exercise_name: 'bench pres', sets: 3, reps: 5 }] }))
      .toThrow(/no exercise named "bench pres"\. Closest matches: .*barbell bench press \(0025\)/)
    expect(() => createRoutine(S, { name: 'x', exercises: [{ exercise_id: 'nope', sets: 3, reps: 5 }] })).toThrow(/no exercise with id/)
    expect(() => createRoutine(S, { name: 'x', exercises: [{ exercise_id: '0025', exercise_name: 'barbell bench press', sets: 3, reps: 5 }] })).toThrow(/exactly one of/)
    expect(() => createRoutine(S, { name: 'x', exercises: [{ exercise_id: '0025', sets: 3 }] })).toThrow(/give reps/)
    expect(() => createRoutine(S, { name: 'x', exercises: [{ exercise_id: '0025', sets: 3, reps_min: 8, reps_max: 6 }] })).toThrow(/must be below/)
    expect(() => createRoutine(S, { name: 'x', exercises: [station('plyo push up'), { exercise_id: '0025', sets: 3, reps: 5 }, station('jump rope')] }))
      .toThrow(/one after another/)
    expect(JSON.stringify(S)).toBe(snapshot)
  })
})

describe('update_routine', () => {
  test('renames and replaces the exercise list, keeping the id and the schedule', () => {
    const r = S.routines[0]
    const weekBefore = JSON.stringify(S.week)
    const out = updateRoutine(S, { routine_id: r.id, name: 'Push A', exercises: [{ exercise_id: '0025', sets: 5, reps: 5, weight: 80 }] })
    const same = S.routines.find(x => x.id === r.id)
    expect(same.name).toBe('Push A')
    expect(same.ex).toEqual([{ id: '0025', sets: 5, reps: 5, weight: 80 }])
    expect(S.routines.filter(x => x.name === 'scratch')).toEqual([])
    expect(JSON.stringify(S.week)).toBe(weekBefore)
    expect(out.exercises).toEqual(['barbell bench press: 5 × 5 · 80 kg'])
  })
  test('an unknown routine or nothing to change is refused', () => {
    expect(() => updateRoutine(S, { routine_id: 'nope', name: 'x' })).toThrow(/no routine/)
    expect(() => updateRoutine(S, { routine_id: S.routines[0].id })).toThrow(/nothing to change/)
  })
})

describe('set_week_plan', () => {
  test('sets the listed days, [] makes a rest day, others untouched', () => {
    const [a, b] = S.routines
    const wed = JSON.stringify(S.week[3])
    const out = setWeekPlan(S, { days: { mon: [b.id, a.id], tue: [] } })
    expect(S.week[1]).toEqual([b.id, a.id])
    expect(S.week[2]).toBeUndefined()
    expect(JSON.stringify(S.week[3])).toBe(wed)
    expect(out.days).toEqual({ mon: [b.name, a.name], tue: [] })
  })
  test('a routine id that does not exist is refused', () => {
    expect(() => setWeekPlan(S, { days: { mon: ['nope'] } })).toThrow(/no routine with id "nope"/)
  })
  test('a profile planning by rotation is told the weekday table does not drive it', () => {
    S.scheduleMode = 'rotation'
    expect(setWeekPlan(S, { days: { mon: [] } }).note).toMatch(/rotation/)
  })
})

describe('add_bodyweight / add_measurements', () => {
  const NOW = new Date('2026-10-24T09:00:00').getTime()
  test('a weigh-in on a new day is added in date order; the same day replaces', () => {
    const out = addBodyweight(S, { weight: 180, unit: 'lb', date: '2026-10-20' }, NOW)
    expect(out).toEqual({ date: '2026-10-20', weight: 81.6, unit: 'kg' })
    expect(S.bodyweight.find(b => b.d === '2026-10-20')).toEqual({ d: '2026-10-20', w: 81.6, t: NOW })
    expect(S.bodyweight.map(b => b.d)).toEqual([...S.bodyweight.map(b => b.d)].sort())
    expect(addBodyweight(S, { weight: 81.2, date: '2026-10-20' }, NOW).replaced).toBe(81.6)
    expect(S.bodyweight.filter(b => b.d === '2026-10-20')).toHaveLength(1)
  })
  test('defaults to today', () => {
    expect(addBodyweight(S, { weight: 80 }, NOW).date).toBe('2026-10-24')
  })
  test('measurements are stored in cm and merged into the day\'s entry', () => {
    addMeasurements(S, { values: { waist: 86, chest: 100 }, date: '2026-10-20' }, NOW)
    const out = addMeasurements(S, { values: { waist: 34, bodyFat: 18 }, unit: 'in', date: '2026-10-20' }, NOW)
    expect(out.values).toEqual({ waist: 86.4, bodyFat: 18 })
    const day = S.measurements.filter(e => e.d === '2026-10-20')
    expect(day).toHaveLength(1)
    expect(day[0]).toMatchObject({ waist: 86.4, chest: 100, bodyFat: 18 })
  })
  test('an unknown measurement is refused', () => {
    expect(() => addMeasurements(S, { values: { biceps: 40 } }, NOW)).toThrow(/unknown measurement biceps/)
  })
})

describe('log_workout', () => {
  // The demo's history runs up to yesterday, so "today" is the day after its last session.
  const benchPlan = () => buildCombinedEntries(S, [S.routines[0].id]).entries.find(e => e.id === '0025')

  test('a routine session: its entries matched by exercise, sets ticked, filed last, stamped', () => {
    const push = S.routines[0]
    const before = S.workouts.length
    const r = logWorkout(S, {
      routine_id: push.id, start_time: '07:15', duration_min: 50, note: 'early one',
      exercises: [
        { exercise_id: '0025', note: 'felt strong', sets: [{ reps: 10, weight: 40, warmup: true }, { reps: 8, weight: 60, rir: 2 }, { reps: 8, weight: 60, rpe: 9 }, { reps: 6, weight: 60, failure: true }] },
        { exercise_name: 'front plank', sets: [{ seconds: 60 }, { seconds: 45 }] }
      ]
    })
    expect(S.workouts.length).toBe(before + 1)
    const w = S.workouts.at(-1)
    expect(w.id).toBe(r.workout_id)
    expect(w).toMatchObject({ name: 'Push Day', routineIds: [push.id], routineId: push.id, note: 'early one' })
    expect(w.end - w.start).toBe(50 * 60000)
    expect(new Date(w.start).getHours()).toBe(7)
    expect(w._ts).toBeGreaterThan(0)
    const [bench, plank] = w.entries
    expect(bench).toMatchObject({ id: '0025', rid: push.id, topW: 60, note: 'felt strong' })
    expect(bench.planned).toBeTruthy()
    expect(bench.sets).toEqual([
      { done: true, w: 40, r: 10, phase: 'warmup', warmup: true },
      { done: true, w: 60, r: 8, rir: 2 },
      { done: true, w: 60, r: 8, rpe: 9 },
      { done: true, w: 60, r: 6, failure: true }
    ])
    // Not in the routine: added the way the workout screen adds one to a planned session.
    expect(plank).toMatchObject({ id: '0463', rid: push.id, sets: [{ done: true, sec: 60 }, { done: true, sec: 45 }] })
    expect(plank.target).toMatchObject({ mode: 'time', sec: 60 })
    // Work sets only, as the app counts volume.
    expect(w.vol).toBe(60 * 8 + 60 * 8 + 60 * 6)
    expect(r).toMatchObject({ name: 'Push Day', duration_min: 50, volume: 1320, sets_done: 6 })
    expect(r.exercises[0]).toBe('barbell bench press: 40×10, 60×8 (RIR 2), 60×8 (RPE 9), 60×6 F')
  })

  test('the next session moves on from it, as it would after Finish in the app', () => {
    const plan = benchPlan().target
    logWorkout(S, { routine_id: S.routines[0].id, exercises: [{ exercise_id: '0025', sets: Array(plan.sets).fill({ reps: plan.reps, weight: plan.weight }) }] })
    expect(benchPlan().target.weight).toBeGreaterThan(plan.weight)
  })

  test('a PR only for a load that leads the history before it', () => {
    const plan = benchPlan().target
    const light = logWorkout(S, { exercises: [{ exercise_id: '0025', sets: [{ reps: 5, weight: 20 }] }] })
    expect(light.new_prs).toEqual([])
    const heavy = logWorkout(S, { exercises: [{ exercise_id: '0025', sets: [{ reps: 1, weight: plan.weight + 50 }] }] })
    expect(heavy.new_prs).toEqual(['barbell bench press'])
    expect(S.workouts.at(-1).prs).toEqual(['0025'])
  })

  test('freestyle: no routine, named Freestyle, exercises as done; a day in the past is filed in order', () => {
    const r = logWorkout(S, { date: S.workouts[0].d, start_time: '05:00', exercises: [{ exercise_name: 'jump rope', sets: [{ minutes: 10 }] }] })
    const at = S.workouts.findIndex(w => w.id === r.workout_id)
    expect(at).toBe(0)
    expect(S.workouts[0]).toMatchObject({ name: 'Freestyle', routineIds: [] })
    expect(S.workouts[0].entries[0]).toMatchObject({ id: '2612', sets: [{ done: true, min: 10 }] })
    expect(S.workouts[0].entries[0].rid).toBeUndefined()
  })

  test('replace_workout_id re-logs a day instead of adding a second workout', () => {
    const old = S.workouts.at(-1)
    const n = S.workouts.length
    const r = logWorkout(S, { date: old.d, replace_workout_id: old.id, exercises: [{ exercise_id: '0025', sets: [{ reps: 5, weight: 50 }] }] })
    expect(S.workouts.length).toBe(n)
    expect(S.workouts.some(w => w.id === old.id)).toBe(false)
    expect(r.replaced).toBe(old.id)
  })

  test('a superset from the routine stays a superset, and one member alone is not one', () => {
    const c = createRoutine(S, { name: 'Circuit', exercises: [station('plyo push up'), station('jump rope')] })
    const both = [{ exercise_id: '1306', sets: [{ seconds: 60 }] }, { exercise_id: '2612', sets: [{ seconds: 60 }] }]
    logWorkout(S, { routine_id: c.routine_id, exercises: both })
    const [a, b] = S.workouts.at(-1).entries
    expect(a.sg).toBeTruthy()
    expect(b.sg).toBe(a.sg)
    logWorkout(S, { routine_id: c.routine_id, exercises: both.slice(1) })
    expect(S.workouts.at(-1).entries[0].sg).toBeUndefined()
  })

  test('refusals', () => {
    const ex = [{ exercise_id: '0025', sets: [{ reps: 5, weight: 50 }] }]
    expect(() => logWorkout(S, { date: '2999-01-01', exercises: ex })).toThrow(/in the future/)
    expect(() => logWorkout(S, { routine_id: 'nope', exercises: ex })).toThrow(/no routine/)
    expect(() => logWorkout(S, { replace_workout_id: 'nope', exercises: ex })).toThrow(/no workout/)
    expect(() => logWorkout(S, { exercises: [{ exercise_id: '0025', sets: [{ reps: 5, rir: 1, rpe: 9 }] }] })).toThrow(/not both/)
    expect(() => logWorkout(S, { exercises: [{ exercise_id: '0025', sets: [{ weight: 50 }] }] })).toThrow(/needs reps/)
    expect(() => logWorkout(S, { exercises: [{ exercise_name: 'bench pres', sets: [{ reps: 5 }] }] })).toThrow(/Closest matches/)
  })
})

describe('registration', () => {
  test('every write tool has a schema and an apply; find_exercise is a read tool', () => {
    expect(WRITE_TOOLS.map(t => t.name)).toEqual(['create_routine', 'update_routine', 'set_week_plan', 'add_bodyweight', 'add_measurements', 'log_workout'])
    for (const t of WRITE_TOOLS) { expect(typeof t.apply).toBe('function'); expect(t.schema).toBeTruthy() }
    _seedStateForTests(S)
    const find = TOOLS.find(t => t.name === 'find_exercise')
    expect(find.handler({ query: 'jump rope' }).results[0].id).toBe('2612')
  })
})
