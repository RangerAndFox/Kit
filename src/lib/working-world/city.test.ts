import { it } from 'node:test'
import assert from 'node:assert/strict'
import { cityPoint, DEFAULT_CITY_VIEW, hitCity, normalizeView } from './city'
it('rotates actual geometry in exactly eight 45-degree steps', () => {
  const p = cityPoint(2, 5, 0, 1000, 700, DEFAULT_CITY_VIEW)
  const q = cityPoint(2, 5, 0, 1000, 700, { ...DEFAULT_CITY_VIEW, rotation: 1 })
  assert.notDeepEqual(p, q)
  assert.deepEqual(cityPoint(2, 5, 0, 1000, 700, { ...DEFAULT_CITY_VIEW, rotation: 8 }), p)
  assert.equal(normalizeView({ rotation: -1 }).rotation, 7)
})
it('zoom is bounded and nonfinite saved camera values cannot break rendering', () => {
  assert.equal(normalizeView({ zoom: 100 }).zoom, 2.5)
  assert.equal(normalizeView({ zoom: 0 }).zoom, .65)
  assert.deepEqual(normalizeView({ zoom: NaN, rotation: Infinity, panX: NaN }), DEFAULT_CITY_VIEW)
  const center = cityPoint(9.5, 9.5, 45, 1000, 700, { ...DEFAULT_CITY_VIEW, zoom: 2 })
  assert.deepEqual(center, { x: 500, y: 350 })
})
it('selects the front-most accessible hit and ignores empty ground', () => {
  const hits = [{ id: 'building', x: 10, y: 10, radius: 20 }, { id: 'agent', x: 10, y: 10, radius: 10 }]
  assert.equal(hitCity(hits, 10, 10), 'agent'); assert.equal(hitCity(hits, 100, 100), null)
})
