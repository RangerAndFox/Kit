import type { DistrictId, WorldAgent, WorldState } from './types'

export interface CityView { zoom: number; rotation: number; panX: number; panY: number }
export const DEFAULT_CITY_VIEW: CityView = { zoom: 1, rotation: 0, panX: 0, panY: 0 }
export function normalizeView(input: Partial<CityView>): CityView {
  const finite = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return { zoom: Math.min(2.5, Math.max(.65, finite(input.zoom, 1))), rotation: ((Math.round(finite(input.rotation, 0)) % 8) + 8) % 8,
    panX: Math.min(1200, Math.max(-1200, finite(input.panX, 0))), panY: Math.min(900, Math.max(-900, finite(input.panY, 0))) }
}
export interface CityBuilding { district: DistrictId; label: string; sign: string; x: number; y: number; h: number; color: string }
export const CITY_BUILDINGS: readonly CityBuilding[] = [
  { district: 'production', label: 'PRODUCTION', sign: 'STUDIO', x: 2, y: 2, h: 95, color: '#b0a3ce' },
  { district: 'knowledge', label: 'KNOWLEDGE', sign: 'LIBRARY', x: 8, y: 2, h: 105, color: '#e1dfb9' },
  { district: 'engineering', label: 'ENGINEERING', sign: 'BUILD', x: 14, y: 2, h: 75, color: '#8bb4cd' },
  { district: 'people', label: 'PEOPLE', sign: 'WELCOME', x: 2, y: 8, h: 80, color: '#dc8c78' },
  { district: 'hq', label: 'KIT HQ', sign: 'R&F', x: 8, y: 8, h: 145, color: '#8ecdb4' },
  { district: 'marketing', label: 'MARKETING', sign: 'ON AIR', x: 14, y: 8, h: 104, color: '#e3c97f' },
  { district: 'finance', label: 'FINANCE', sign: 'HOURS', x: 2, y: 14, h: 88, color: '#e1dfb9' },
  { district: 'delivery', label: 'DELIVERY', sign: 'DELIVERY', x: 8, y: 14, h: 75, color: '#8bb4cd' },
  { district: 'archive', label: 'ARCHIVE', sign: 'GALLERY', x: 14, y: 14, h: 86, color: '#dc8c78' },
]
interface Point { x: number; y: number }
export interface CityHit { id: string; x: number; y: number; radius: number }
export const WORLD_COLORS: Record<WorldState, string> = { working: '#9be596', waiting: '#ecc16a', blocked: '#ee856e', idle: '#a5c5b4', unknown: '#9daaa5', unconnected: '#9daaa5' }
function rotate(x: number, y: number, rotation: number): Point {
  const angle = rotation * Math.PI / 4, c = Math.cos(angle), s = Math.sin(angle)
  return { x: (x - 9.5) * c - (y - 9.5) * s, y: (x - 9.5) * s + (y - 9.5) * c }
}
export function cityPoint(x: number, y: number, z: number, width: number, height: number, input: CityView): Point {
  const view = normalizeView(input), r = rotate(x, y, view.rotation), scale = Math.min(width / 1050, height / 730) * view.zoom
  return { x: width / 2 + view.panX + (r.x - r.y) * 24 * scale, y: height / 2 + view.panY + ((r.x + r.y) * 12 - z + 45) * scale }
}
export function hitCity(hits: CityHit[], x: number, y: number): string | null {
  return hits.slice().reverse().find(h => Math.hypot(h.x - x, h.y - y) <= h.radius)?.id || null
}

const INK = '#29433a', CREAM = '#f0edcd', ROAD = '#6b877b'
const shade = (hex: string, f: number) => '#' + [0, 2, 4].map(i => Math.min(255, Math.round(parseInt(hex.slice(1 + i, 3 + i), 16) * f)).toString(16).padStart(2, '0')).join('')

/** Canvas-native pixel city. Camera rotation changes world geometry and depth,
 * not a CSS transform of a flat screenshot. It has no network or workflow API. */
export function drawCity(ctx: CanvasRenderingContext2D, args: {
  width: number; height: number; view: CityView; agents: WorldAgent[]; selected: string; time: number; stale: boolean
}): CityHit[] {
  const { width, height, agents, selected, time, stale } = args, view = normalizeView(args.view)
  const scale = Math.min(width / 1050, height / 730) * view.zoom
  const p = (x: number, y: number, z = 0) => cityPoint(x, y, z, width, height, view)
  const depth = (x: number, y: number) => { const r = rotate(x, y, view.rotation); return r.x + r.y }
  const hits: CityHit[] = []
  ctx.clearRect(0, 0, width, height); ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#c8ddc8'; ctx.fillRect(0, 0, width, height)
  function polygon(points: Point[], fill: string, stroke = true) {
    ctx.beginPath(); points.forEach((q, i) => i ? ctx.lineTo(Math.round(q.x), Math.round(q.y)) : ctx.moveTo(Math.round(q.x), Math.round(q.y))); ctx.closePath()
    ctx.fillStyle = fill; ctx.fill(); if (stroke) { ctx.strokeStyle = INK; ctx.lineWidth = Math.max(.6, scale); ctx.stroke() }
  }
  function line(a: Point, b: Point, color = INK, w = 1) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.strokeStyle = color; ctx.lineWidth = Math.max(.6, w * scale); ctx.stroke() }
  function tile(x: number, y: number, w: number, d: number, color: string) { polygon([p(x, y), p(x + w, y), p(x + w, y + d), p(x, y + d)], color, false) }
  function box(x: number, y: number, w: number, d: number, top: number, color: string, bottom = 0) {
    const corners = [[x, y], [x + w, y], [x + w, y + d], [x, y + d]]
    const angle = view.rotation * Math.PI / 4, c = Math.cos(angle), s = Math.sin(angle)
    const normals = [[0, -1], [1, 0], [0, 1], [-1, 0]]
    for (let i = 0; i < 4; i++) {
      const [nx, ny] = normals[i], facing = nx * (c + s) + ny * (c - s)
      if (facing <= .0001) continue
      const a = corners[i], b = corners[(i + 1) % 4]
      polygon([p(a[0], a[1], top), p(b[0], b[1], top), p(b[0], b[1], bottom), p(a[0], a[1], bottom)], shade(color, i % 2 ? .71 : .86))
    }
    polygon(corners.map(q => p(q[0], q[1], top)), color)
  }
  function sign(text: string, point: Point, color = CREAM, big = false) {
    const font = Math.max(10, Math.min(15, (big ? 16 : 12) * scale)), w = text.length * font * .63 + 10
    ctx.fillStyle = INK; ctx.fillRect(Math.round(point.x - w / 2), Math.round(point.y - font), Math.round(w), Math.round(font + 8))
    ctx.fillStyle = color; ctx.fillRect(Math.round(point.x - w / 2 + 1), Math.round(point.y - font + 1), Math.round(w - 2), Math.round(font + 6))
    ctx.fillStyle = INK; ctx.font = `500 ${font}px ui-monospace,monospace`; ctx.textAlign = 'center'; ctx.fillText(text, point.x, point.y + 2)
  }
  function pixel(x: number, y: number, w: number, h: number, color: string) { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))) }
  polygon([p(-.5, -.5), p(19.5, -.5), p(19.5, 19.5), p(-.5, 19.5)], '#abc7b0')
  for (let x = 0; x < 19; x++) for (let y = 0; y < 19; y++) {
    const road = [6, 7, 12, 13, 18].includes(x) || [6, 7, 12, 13, 18].includes(y)
    tile(x, y, 1, 1, road ? ROAD : (x + y) % 3 ? '#bed3b9' : '#c8dabf')
    if (road && (x === 6 || x === 12 || x === 18) && y % 3 === 0) line(p(x + .95, y + .3), p(x + .95, y + .9), '#c2d0b4', 2)
    if (road && (y === 6 || y === 12 || y === 18) && x % 3 === 0) line(p(x + .3, y + .95), p(x + .9, y + .95), '#c2d0b4', 2)
  }
  for (const n of [6, 12]) for (let j = 0; j < 5; j++) tile(n + .1 + j * .32, 7.15, .15, 1.5, CREAM)
  const scene: Array<{ depth: number; paint: () => void }> = []
  for (const b of CITY_BUILDINGS) {
    const agent = agents.find(a => a.district === b.district), state = stale ? 'unknown' : agent?.state || 'unconnected'
    if (agent?.id === selected) tile(b.x - .3, b.y - .3, 3.6, 3.6, '#e7e8a5')
    tile(b.x - .1, b.y - .1, 3.2, 3.2, '#dfe6c7')
    const d = Math.max(...[[b.x, b.y], [b.x + 3, b.y], [b.x, b.y + 3], [b.x + 3, b.y + 3]].map(q => depth(q[0], q[1])))
    scene.push({ depth: d, paint: () => {
      const color = state === 'unconnected' || state === 'unknown' ? '#a4b4ad' : b.color
      box(b.x, b.y, 3, 3, b.h, color); box(b.x + .17, b.y + .17, 2.66, 2.66, b.h + 5, shade(color, 1.03), b.h)
      // Windows live on world-space walls and remain attached while rotating.
      for (const side of [0, 1, 2, 3]) {
        const angle = view.rotation * Math.PI / 4, normals = [[0, -1], [1, 0], [0, 1], [-1, 0]], n = normals[side]
        if (n[0] * (Math.cos(angle) + Math.sin(angle)) + n[1] * (Math.cos(angle) - Math.sin(angle)) <= 0) continue
        for (let column = 0; column < 3; column++) for (let row = 0; row < Math.floor((b.h - 30) / 24); row++) {
          const offset = .3 + column * .88, z = 34 + row * 24
          const a = side % 2 ? [b.x + (side === 1 ? 3 : 0), b.y + offset] : [b.x + offset, b.y + (side === 2 ? 3 : 0)]
          const c = side % 2 ? [a[0], a[1] + .48] : [a[0] + .48, a[1]]
          polygon([p(a[0], a[1], z), p(c[0], c[1], z), p(c[0], c[1], z + 12), p(a[0], a[1], z + 12)], state === 'unconnected' ? '#bdd1c3' : '#dce9bb')
        }
      }
      if (b.district === 'hq') {
        box(b.x + .7, b.y + .7, 1.6, 1.6, b.h + 20, INK, b.h + 5)
        const q = p(b.x + 1.5, b.y + 1.5, b.h + 26); sign('R&F', q, '#b1ed8b', true)
        const pole = p(b.x + 1.5, b.y + 1.5, b.h + 58); line(q, pole, INK, 2); pixel(pole.x, pole.y, 24 * scale, 13 * scale, '#d98665')
      } else if (b.district === 'marketing') {
        const a = p(b.x + 1, b.y + 1, b.h + 5), c = p(b.x + 1, b.y + 1, b.h + 58); line(a, c, INK, 3)
        for (const h of [20, 36, 49]) { const q = p(b.x + 1, b.y + 1, b.h + h); line({ x: q.x - 12 * scale, y: q.y }, { x: q.x + 12 * scale, y: q.y }) }
      } else if (b.district === 'knowledge') {
        for (let i = 0; i < 4; i++) box(b.x + .5 + i * .4, b.y + .7, .25, .8, b.h + 15, ['#dc9579', '#9bb9cd', '#ccb1d5', '#d8be72'][i], b.h + 5)
      } else if (b.district === 'delivery') {
        box(b.x - .7, b.y + 1.4, .6, .6, 18, '#e3bb72'); box(b.x - .7, b.y + 2.1, .6, .6, 18, '#ce957b')
      } else if (b.district === 'engineering') box(b.x + .4, b.y + .5, 1, .8, b.h + 15, '#647b70', b.h + 5)
      else if (b.district === 'people') box(b.x + .7, b.y + .7, 1.4, 1.1, b.h + 15, '#e4c6a0', b.h + 5)
      const roof = p(b.x + 1.5, b.y + 1.5, b.h + 8)
      if (b.district !== 'hq') sign(b.sign, roof, color)
      if (['waiting', 'blocked', 'unknown', 'unconnected'].includes(state)) {
        const marker = p(b.x + 2.8, b.y + 2.8, b.h + 30)
        sign(state === 'blocked' ? '!' : state === 'waiting' ? 'WAIT' : '?', marker, WORLD_COLORS[state])
      }
      if (agent) hits.push({ id: agent.id, x: roof.x, y: roof.y + 30 * scale, radius: Math.max(24, 60 * scale) })
    } })
  }
  for (const [x, y] of [[1, 4], [1, 10], [1, 16], [5, 1], [11, 1], [17, 1], [17, 5], [17, 11], [17, 17]]) {
    scene.push({ depth: depth(x + .5, y + .5), paint: () => { box(x, y, .13, .13, 18, '#99826a'); box(x - .3, y - .3, .75, .75, 35, '#7caa87', 18); box(x - .12, y - .12, .4, .4, 46, '#95b997', 35) } })
  }
  agents.forEach((a, i) => {
    const b = CITY_BUILDINGS.find(b => b.district === a.district)
    if (!b) return
    const state = stale ? 'unknown' : a.state
    let x = b.x - .45, y = b.y + 3.3
    if (state === 'working') {
      const route = [[b.x - .5, b.y + 3.4], [b.x + 3.3, b.y + 3.4], [b.x + 3.3, b.y - .5], [b.x - .5, b.y - .5]]
      const phase = (time * .14 + i * .43) % 4, from = route[Math.floor(phase)], to = route[(Math.floor(phase) + 1) % 4], f = phase % 1
      x = from[0] + (to[0] - from[0]) * f; y = from[1] + (to[1] - from[1]) * f
    }
    scene.push({ depth: depth(x, y), paint: () => {
      const q = p(x, y), s = Math.max(.85, scale * 1.8)
      if (a.id === selected) polygon([{ x: q.x, y: q.y + 4 * s }, { x: q.x + 12 * s, y: q.y + 9 * s }, { x: q.x, y: q.y + 14 * s }, { x: q.x - 12 * s, y: q.y + 9 * s }], CREAM)
      ctx.save(); ctx.translate(Math.round(q.x), Math.round(q.y)); ctx.scale(s, s)
      const r = (x: number, y: number, w: number, h: number, c: string) => pixel(x, y, w, h, c)
      r(-4, -9, 3, 10, INK); r(2, -9, 3, 10, INK); r(-6, -21, 12, 13, state === 'unknown' || state === 'unconnected' ? '#a6b8af' : a.color)
      r(-8, -19, 3, 10, '#e3b88f'); r(6, -19, 3, 10, '#e3b88f'); r(-5, -31, 10, 10, '#edc49c'); r(-6, -33, 12, 5, i % 2 ? '#92754d' : INK)
      r(0, -28, 2, 2, INK); r(4, -28, 2, 2, INK); r(-2, -18, 4, 4, CREAM)
      if (state === 'working' && Math.floor(time * 5) % 2) { r(-6, 0, 5, 2, INK); r(2, -2, 5, 2, INK) }
      if (state === 'blocked' || state === 'waiting') { r(9, -40, 15, 16, WORLD_COLORS[state]); ctx.fillStyle = INK; ctx.font = '500 12px monospace'; ctx.textAlign = 'center'; ctx.fillText(state === 'blocked' ? '!' : '…', 16, -28) }
      ctx.restore(); hits.push({ id: a.id, x: q.x, y: q.y - 17 * s, radius: Math.max(20, 19 * s) })
    } })
  })
  // Foxes are explicitly decorative; they never generate work or status events.
  for (let i = 0; i < 3; i++) {
    const t = (time * .035 + i / 3) % 1, x = i === 1 ? 12.6 : 6.6, y = 1 + t * 17
    scene.push({ depth: depth(x, y), paint: () => {
      const q = p(x, y), s = Math.max(.7, scale * 1.35), face = i % 2 ? -1 : 1
      ctx.save(); ctx.translate(q.x, q.y); ctx.scale(s * face, s)
      pixel(-13, -10, 14, 7, '#d47749'); pixel(-17, -13, 7, 7, '#e59661'); pixel(-19, -14, 4, 4, CREAM)
      pixel(-1, -14, 11, 10, '#d47749'); pixel(-1, -20, 4, 8, '#b65e3c'); pixel(6, -20, 4, 8, '#b65e3c')
      pixel(5, -10, 9, 5, CREAM); pixel(12, -10, 3, 3, INK); pixel(6, -14, 2, 2, INK)
      pixel(-10, -4, 3, 7, INK); pixel(-2, -4, 3, 7, INK); ctx.restore()
    } })
  }
  scene.sort((a, b) => a.depth - b.depth).forEach(item => item.paint())
  return hits
}
