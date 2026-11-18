'use client'

import { memo, useEffect, useRef } from 'react'
import { drawCity, hitCity, normalizeView, type CityHit, type CityView } from '@/lib/working-world/city'
import type { WorldAgent } from '@/lib/working-world/types'
import styles from './working-world.module.css'

interface Props { agents: WorldAgent[]; selected: string; view: CityView; paused: boolean; stale: boolean; onSelect: (id: string) => void; onView: (view: CityView) => void }

export const CityCanvas = memo(function CityCanvas(props: Props) {
  const canvas = useRef<HTMLCanvasElement>(null), state = useRef(props), hits = useRef<CityHit[]>([]), elapsed = useRef(0)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean; distance: number | null; zoom: number } | null>(null)
  useEffect(() => { state.current = props }, [props])
  useEffect(() => {
    const element = canvas.current, context = element?.getContext('2d')
    if (!element || !context) return
    let width = 0, height = 0, frame = 0, previous = performance.now(), lastPaint = 0, needsPaint = true
    const paint = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = element.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      if (rect.width !== width || rect.height !== height) {
        width = rect.width; height = rect.height
        element.width = Math.round(width * dpr); element.height = Math.round(height * dpr)
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      const p = state.current
      hits.current = drawCity(context, { width, height, view: p.view, agents: p.agents, selected: p.selected, time: elapsed.current, stale: p.stale })
    }
    const tick = (now: number) => {
      const dt = Math.min(.1, (now - previous) / 1000); previous = now
      const moving = !state.current.paused && !document.hidden
      if (moving) elapsed.current += dt
      if (!document.hidden && (needsPaint || moving) && now - lastPaint >= 1000 / 24) { paint(); lastPaint = now; needsPaint = false }
      frame = requestAnimationFrame(tick)
    }
    const observer = new ResizeObserver(() => { needsPaint = true; paint() }); observer.observe(element)
    const dirty = () => { needsPaint = true }
    element.addEventListener('world-paint', dirty)
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = state.current.view, bounds = element.getBoundingClientRect()
      const zoom = normalizeView({ ...current, zoom: current.zoom * Math.exp(-event.deltaY * .0015) }).zoom
      const ratio = zoom / current.zoom, x = event.clientX - bounds.left - bounds.width / 2, y = event.clientY - bounds.top - bounds.height / 2
      state.current.onView(normalizeView({ ...current, zoom, panX: x - (x - current.panX) * ratio, panY: y - (y - current.panY) * ratio }))
    }
    element.addEventListener('wheel', wheel, { passive: false }); paint(); frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame); observer.disconnect(); element.removeEventListener('wheel', wheel); element.removeEventListener('world-paint', dirty) }
  }, [])
  useEffect(() => { canvas.current?.dispatchEvent(new Event('world-paint')) }, [props.agents, props.selected, props.view, props.stale, props.paused])
  return <canvas ref={canvas} className={styles.canvas} aria-label="Ranger and Fox agent city. Drag to pan, scroll or pinch to zoom. Use the agent picker and camera buttons for keyboard access. Foxes are decorative."
    onPointerDown={event => {
      event.currentTarget.setPointerCapture(event.pointerId)
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const pair = [...pointers.current.values()]
      drag.current = { x: event.clientX, y: event.clientY, panX: props.view.panX, panY: props.view.panY, moved: pair.length > 1,
        distance: pair.length === 2 ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : null, zoom: props.view.zoom }
    }}
    onPointerMove={event => {
      if (!pointers.current.has(event.pointerId) || !drag.current) return
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const pair = [...pointers.current.values()], start = drag.current
      if (pair.length === 2 && start.distance) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y)
        start.moved = true; props.onView(normalizeView({ ...props.view, zoom: start.zoom * distance / start.distance })); return
      }
      const dx = event.clientX - start.x, dy = event.clientY - start.y
      if (Math.hypot(dx, dy) > 4) start.moved = true
      if (start.moved) props.onView(normalizeView({ ...props.view, panX: start.panX + dx, panY: start.panY + dy }))
    }}
    onPointerUp={event => {
      const start = drag.current; pointers.current.delete(event.pointerId)
      if (pointers.current.size) { drag.current = null; return }
      if (start && !start.moved) {
        const bounds = event.currentTarget.getBoundingClientRect(), id = hitCity(hits.current, event.clientX - bounds.left, event.clientY - bounds.top)
        if (id) props.onSelect(id)
      }
      drag.current = null
    }}
    onPointerCancel={() => { pointers.current.clear(); drag.current = null }} />
})
