import { describe, expect, it } from 'vitest'
import { anchorsByWorkout, FATIGUE_RIR_WINDOW_MS } from './recovery.js'

const DAY = 86400000
const workout = (start, entries) => ({ start, entries: Object.entries(entries).map(([id, w]) => ({
  id, sets: [{ done: true, w, r: 5 }],
})) })

// An independent full-window scan, using single-session anchors only to obtain each
// session's estimates. Exercises, timestamps and input order vary independently.
function reference(workouts) {
  const ordered = workouts.map((w, index) => ({ w, index }))
    .filter(({ w }) => Number.isFinite(w.start))
    .sort((a, b) => a.w.start - b.w.start || a.index - b.index)
  const bests = ordered.map(({ w }) => anchorsByWorkout([w]).get(w))
  return new Map(ordered.map(({ w }, i) => {
    const anchors = new Map()
    for (let j = 0; j <= i; j++) {
      if (ordered[j].w.start <= w.start - FATIGUE_RIR_WINDOW_MS) continue
      for (const [id, value] of bests[j]) anchors.set(id, Math.max(anchors.get(id) || 0, value))
    }
    return [w, anchors]
  }))
}

const expectReference = workouts => {
  const actual = anchorsByWorkout(workouts)
  const expected = reference(workouts)
  expect(actual.size).toBe(expected.size)
  for (const [w, anchors] of expected) expect(actual.get(w)).toEqual(anchors)
}

describe('rolling recovery anchors', () => {
  it('expires the exact 90-day boundary, restores smaller maxima and drops inactive exercises', () => {
    const workouts = [
      workout(0, { '0027': 100, '0293': 80 }),
      workout(DAY, { '0027': 90 }),
      workout(2 * DAY, { '0027': 90 }),
      workout(90 * DAY - 1, {}),
      workout(90 * DAY, {}),
      workout(91 * DAY, {}),
      workout(92 * DAY, {}),
    ]
    expectReference(workouts)
    const result = anchorsByWorkout(workouts)
    expect(result.get(workouts[4]).has('0293')).toBe(false)
    expect(result.get(workouts[6]).size).toBe(0)
  })

  it('keeps input order for tied timestamps, independent snapshots and ignores invalid dates', () => {
    const first = workout(DAY, { '0027': 50 })
    const second = workout(DAY, { '0027': 100 })
    const workouts = [workout(2 * DAY, {}), first, second, { entries: [] }]
    expectReference(workouts)
    const result = anchorsByWorkout(workouts)
    expect(result.get(first).get('0027')).toBeLessThan(result.get(second).get('0027'))
    expect(result.get(first)).not.toBe(result.get(second))
  })

  it('matches a full-window scan over shuffled, sparse, and dense histories', () => {
    let seed = 42
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    for (let trial = 0; trial < 6; trial++) {
      const workouts = Array.from({ length: 240 }, () => workout(Math.floor(random() * 240) * DAY,
        Object.fromEntries(['0027', '0293', '0739'].filter(() => random() > 0.3)
          .map(id => [id, 20 + Math.floor(random() * 100)]))))
      expectReference(workouts)
    }
  })

  it('handles long decreasing candidate queues and long gaps', () => {
    const workouts = Array.from({ length: 1000 }, (_, i) => workout(i * DAY / 4, { '0027': 1100 - i }))
    workouts.push(workout(1000 * DAY, { '0293': 40 }))
    expectReference(workouts)
  })
})
