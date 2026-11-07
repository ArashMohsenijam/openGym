import { describe, expect, it } from 'vitest'
import { CATALOGUE } from './exercises.js'
import { MUSCLES, musclesOf, exercisesByMuscle } from './muscles.js'

describe('exercise lists by muscle', () => {
  it('matches independent filters for the whole catalogue and custom metadata, in input order', () => {
    const custom = [
      { id: 'custom', bp: 'chest', primaries: ['chest'], secondaries: ['triceps'] },
      { id: 'fallback', bp: 'back' },
      { id: 'unknown', tg: 'unknown' },
    ]
    const catalog = [...custom, ...CATALOGUE]
    const grouped = exercisesByMuscle(catalog)
    expect(Object.keys(grouped)).toEqual(MUSCLES)
    for (const slug of MUSCLES) expect(grouped[slug]).toEqual(catalog.filter(ex => musclesOf(ex)[slug]))
    expect(grouped.chest[0]).toBe(custom[0])
  })

  it('includes empty muscles and reflects changed custom exercises without stale caches', () => {
    expect(Object.values(exercisesByMuscle([])).every(list => list.length === 0)).toBe(true)
    const custom = { id: 'custom', primaries: ['chest'] }
    const first = exercisesByMuscle([custom])
    custom.primaries = ['biceps']
    const next = exercisesByMuscle([custom])
    expect(next.chest).toEqual([])
    expect(next.biceps).toEqual([custom])
    expect(first.chest).toEqual([custom])
  })
})
