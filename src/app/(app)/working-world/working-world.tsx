'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Focus, MessageSquare, Pause, Play, RotateCcw, RotateCw, Send, ZoomIn, ZoomOut } from 'lucide-react'
import { DEFAULT_CITY_VIEW, normalizeView, WORLD_COLORS, type CityView } from '@/lib/working-world/city'
import { WORLD_REFRESH_MS, WORLD_STALE_MS, WORLD_STATE_LABELS } from '@/lib/working-world/catalog'
import { safeWorldHref } from '@/lib/working-world/model'
import type { WorldAnswer, WorldSnapshot, WorldTask } from '@/lib/working-world/types'
import { CityCanvas } from './city-canvas'
import styles from './working-world.module.css'

interface ChatMessage { role: 'user' | 'assistant'; text: string; evidence?: WorldAnswer['evidence'] }
function ago(value: string | null, now: number): string {
  if (!value) return 'No timestamp'
  const ms = now - Date.parse(value)
  if (!Number.isFinite(ms)) return 'Unknown timestamp'
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`
}
function TaskLink({ task, now }: { task: WorldTask; now: number }) {
  const href = safeWorldHref(task.href)
  const content = <><span className={styles.taskTitle}>{task.title}</span>{task.project && <span>{task.project}</span>}<small>{task.recordedStatus} · {ago(task.at, now)}</small></>
  return href ? <a className={styles.task} href={href} target={href.startsWith('https:') ? '_blank' : undefined} rel="noopener noreferrer">{content}<ArrowUpRight size={14} aria-hidden="true" /></a> : <div className={styles.task}>{content}</div>
}

export function WorkingWorld({ initialData }: { initialData: WorldSnapshot }) {
  const [data, setData] = useState(initialData), [selected, setSelected] = useState('kit'), [view, setView] = useState<CityView>(DEFAULT_CITY_VIEW)
  const [paused, setPaused] = useState(false), [clock, setClock] = useState(() => Date.parse(initialData.observedAt)), [error, setError] = useState<string | null>(null)
  const [accessLost, setAccessLost] = useState(false), [tab, setTab] = useState<'details' | 'diagnostics'>('details')
  const [messages, setMessages] = useState<ChatMessage[]>([]), [question, setQuestion] = useState(''), [asking, setAsking] = useState(false)
  const [ready, setReady] = useState(false)
  const chatAbort = useRef<AbortController | null>(null)
  const stale = !!error || clock - Date.parse(data.observedAt) > WORLD_STALE_MS
  const agent = data.agents.find(a => a.id === selected) || data.agents[0]
  const state = stale && agent.state !== 'unconnected' ? 'unknown' : agent.state
  const active = data.agents.filter(a => a.state === 'working').length
  const attention = data.agents.filter(a => ['blocked', 'waiting', 'unknown'].includes(a.state)).length

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onReduced = () => { if (reduced.matches) setPaused(true) }
    reduced.addEventListener('change', onReduced)
    // Keep SSR/hydration identical; read browser preferences on the first frame,
    // before enabling motion. Reduced-motion users never get an initial animation.
    const firstFrame = requestAnimationFrame(() => {
      setPaused(reduced.matches)
      try {
        const saved = JSON.parse(window.localStorage.getItem('rf-working-world-camera') || 'null')
        if (saved?.version === 1) setView(normalizeView(saved))
      } catch { /* A private browser or stale preferences do not block the live view. */ }
      setReady(true)
    })
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => { cancelAnimationFrame(firstFrame); window.clearInterval(timer); reduced.removeEventListener('change', onReduced); chatAbort.current?.abort() }
  }, [])
  const changeView = useCallback((next: CityView) => {
    const valid = normalizeView(next); setView(valid)
    try { window.localStorage.setItem('rf-working-world-camera', JSON.stringify({ version: 1, ...valid })) } catch { /* Optional local preferences only. */ }
  }, [])
  const selectAgent = useCallback((id: string) => setSelected(id), [])
  useEffect(() => {
    let done = false, inFlight = false, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined
    const schedule = (ms = WORLD_REFRESH_MS) => { if (!done) timer = setTimeout(() => void refresh(), ms) }
    const refresh = async () => {
      if (done) return
      if (document.hidden || inFlight) { schedule(); return }
      inFlight = true; controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 18_000)
      let retry = WORLD_REFRESH_MS
      try {
        const response = await fetch('/api/working-world', { cache: 'no-store', signal: controller.signal, credentials: 'same-origin' })
        if (response.status === 403) { done = true; setAccessLost(true); return }
        if (!response.ok) throw new Error('Live records unavailable')
        const next = await response.json() as WorldSnapshot
        if (next.version !== 1 || !Array.isArray(next.agents) || !next.agents.length || !Array.isArray(next.sources)) throw new Error('Invalid activity feed')
        if (!done) { setData(next); setClock(Date.now()); setError(null) }
      } catch { if (!done && !document.hidden) { setError('Live refresh unavailable. Displaying last-known records.'); retry = 30_000 } }
      finally { clearTimeout(timeout); inFlight = false; schedule(retry) }
    }
    const onVisibility = () => {
      if (document.hidden) { if (timer) clearTimeout(timer); controller?.abort(); return }
      if (timer) clearTimeout(timer)
      if (!inFlight) void refresh()
    }
    document.addEventListener('visibilitychange', onVisibility); schedule()
    return () => { done = true; if (timer) clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [])
  const ask = useCallback(async (text: string, agentId?: string) => {
    if (asking || !text.trim()) return
    setTab('diagnostics'); setQuestion(''); setAsking(true)
    setMessages(previous => [...previous.slice(-15), { role: 'user', text: agentId ? `${agentId}: ${text}` : text }])
    const controller = new AbortController(); chatAbort.current = controller
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await fetch('/api/working-world', { method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: text, agentId }) })
      if (response.status === 403) { setAccessLost(true); return }
      if (!response.ok) throw new Error('Diagnostics unavailable')
      const answer = await response.json() as WorldAnswer
      setMessages(previous => [...previous, { role: 'assistant', text: answer.text, evidence: answer.evidence.filter(e => safeWorldHref(e.href)) }])
    } catch { if (!controller.signal.aborted || chatAbort.current === controller) setMessages(previous => [...previous, { role: 'assistant', text: 'I could not read fresh evidence. No fix or retry was executed. Open Control Center to inspect the source.' }]) }
    finally { clearTimeout(timeout); setAsking(false); chatAbort.current = null }
  }, [asking])
  const submit = (event: FormEvent) => { event.preventDefault(); void ask(question) }

  if (accessLost) return <section className={styles.root}><div className={styles.expired}><h1>Session expired</h1><p>Sign in again to view private studio activity.</p><Link href="/login">Sign in</Link></div></section>
  return <section className={styles.root} aria-label="Ranger and Fox Working World">
    <header className={styles.header}>
      <div className={styles.identity}><span className={styles.brand}>R&amp;F</span><div><p className={styles.eyebrow}>Ranger &amp; Fox / operations</p><h1>Working World</h1></div></div>
      <div className={styles.connection}><span className={stale ? styles.offlineDot : styles.liveDot} />{stale ? 'Last-known records' : 'Live records · 10s'}<small>Observed {ago(data.observedAt, clock)}</small></div>
    </header>
    <div className={styles.toolbar}>
      <div className={styles.summary}>{stale ? 'Signal unknown' : `${active} working · ${attention} need attention`}<span>One studio city · read-only</span></div>
      <div className={styles.camera} role="group" aria-label="City camera controls">
        <button type="button" aria-label="Zoom out" onClick={() => changeView({ ...view, zoom: view.zoom - .2 })} disabled={view.zoom <= .65}><ZoomOut size={16} /></button>
        <span className={styles.zoomValue}>{Math.round(view.zoom * 100)}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => changeView({ ...view, zoom: view.zoom + .2 })} disabled={view.zoom >= 2.5}><ZoomIn size={16} /></button>
        <button type="button" aria-label="Rotate left 45 degrees" onClick={() => changeView({ ...view, rotation: view.rotation - 1 })}><RotateCcw size={16} /><span>45°</span></button>
        <button type="button" aria-label="Rotate right 45 degrees" onClick={() => changeView({ ...view, rotation: view.rotation + 1 })}><RotateCw size={16} /><span>45°</span></button>
        <button type="button" aria-label="Reset camera" onClick={() => changeView(DEFAULT_CITY_VIEW)}><Focus size={16} /></button>
        <button type="button" aria-pressed={paused} onClick={() => setPaused(p => !p)}>{paused ? <Play size={15} /> : <Pause size={15} />}<span>{paused ? 'Resume' : 'Pause'} animation</span></button>
      </div>
    </div>
    {error && <p className={styles.warning} role="status">{error}</p>}
    <div className={styles.main}>
      <div className={styles.world}>
        <CityCanvas agents={data.agents} selected={agent.id} view={view} paused={paused || !ready} stale={stale} onSelect={selectAgent} onView={changeView} />
        <div className={styles.worldLabel}>RANGER &amp; FOX<br /><span>Drag to explore · scroll or pinch to zoom</span></div>
        <div className={styles.cameraAngle}>{view.rotation * 45}°</div>
      </div>
      <aside className={styles.inspector} aria-label="Agent details and diagnostics">
        <label className={styles.picker}><span className={styles.eyebrow}>Find an agent / workflow</span><select value={agent.id} onChange={e => setSelected(e.target.value)}>{data.agents.map(a => <option key={a.id} value={a.id}>{a.name} / {a.district}</option>)}</select></label>
        <div className={styles.agentHeading}><span className={styles.agentTile} style={{ backgroundColor: agent.color }}>{agent.name.slice(0, 1)}</span><div><h2>{agent.name}</h2><p>{agent.role}</p></div></div>
        <div className={styles.stateLine}><i style={{ background: WORLD_COLORS[state] }} />{WORLD_STATE_LABELS[state]}</div>
        <div className={styles.tabs} role="tablist" aria-label="Inspector view"><button id="world-details-tab" type="button" role="tab" aria-selected={tab === 'details'} aria-controls="world-details" onClick={() => setTab('details')}>Activity</button><button id="world-chat-tab" type="button" role="tab" aria-selected={tab === 'diagnostics'} aria-controls="world-diagnostics" onClick={() => setTab('diagnostics')}><MessageSquare size={13} />Diagnostics</button></div>
        {tab === 'details' ? <div id="world-details" role="tabpanel" aria-labelledby="world-details-tab" className={styles.details}>
          <p className={styles.description}>{stale ? 'This feed is stale. The records below are last-known evidence, not current progress.' : agent.detail}</p>
          <p className={styles.coverage}>{agent.description}</p>
          <button className={styles.explain} type="button" onClick={() => void ask('What needs attention, and what should happen next?', agent.id)} disabled={asking}><MessageSquare size={14} />Explain this agent</button>
          <div className={styles.taskList}>{agent.tasks.slice(0, 8).map(task => <TaskLink key={task.id} task={task} now={clock} />)}{!agent.tasks.length && <p className={styles.empty}>{state === 'unconnected' ? 'No activity feed connected.' : 'No matching job records.'}</p>}</div>
          <p className={styles.sessionNote}>{agent.sessionHref ? <a href={safeWorldHref(agent.sessionHref) || '/control-center'}>Open source session</a> : 'No direct session URL is supplied by this source. Use a job’s source link when available.'}</p>
        </div> : <div id="world-diagnostics" role="tabpanel" aria-labelledby="world-chat-tab" className={styles.diagnostics}>
          <p className={styles.coverage}>Grounded record lookup—not a general AI chat. No AI calls or operational actions.</p>
          <div className={styles.quickQuestions}><button type="button" onClick={() => void ask('What needs attention?')} disabled={asking}>What needs attention?</button><button type="button" onClick={() => void ask('What needs approval?')} disabled={asking}>What needs approval?</button></div>
          <div className={styles.messages} aria-live="polite">{messages.map((message, i) => <div key={i} className={message.role === 'user' ? styles.userMessage : styles.answer}><span className={styles.eyebrow}>{message.role === 'user' ? 'You' : 'Kit records'}</span><p>{message.text}</p>{message.evidence?.map((e, index) => <a key={`${e.href}:${index}`} href={e.href} target={e.href.startsWith('https:') ? '_blank' : undefined} rel="noopener noreferrer">{e.label}<ArrowUpRight size={12} /></a>)}</div>)}{asking && <p className={styles.coverage}>Reading current evidence…</p>}</div>
          <form onSubmit={submit} className={styles.askForm}><label htmlFor="world-question" className={styles.eyebrow}>Ask about the city</label><div><input id="world-question" value={question} onChange={e => setQuestion(e.target.value)} maxLength={500} placeholder="What is blocking delivery?" autoComplete="off" /><button type="submit" disabled={asking || !question.trim()} aria-label="Ask diagnostics"><Send size={15} /></button></div></form>
        </div>}
      </aside>
    </div>
    <footer className={styles.footer}><div className={styles.legend}>{(['working', 'waiting', 'blocked', 'idle', 'unknown', 'unconnected'] as const).map(s => <span key={s}><i style={{ background: WORLD_COLORS[s] }} />{s === 'waiting' ? 'Approval / queued' : s}</span>)}</div><span>{data.sources.filter(s => s.available).length}/{data.sources.length} data feeds available · foxes are decorative</span></footer>
    <section className={styles.events} aria-label="Recorded activity"><div className={styles.eventsHeader}><h2>Recorded activity</h2><Link href="/control-center">Open Control Center <ArrowUpRight size={13} /></Link></div>{data.events.slice(0, 6).map(task => <TaskLink key={task.id} task={task} now={clock} />)}{!data.events.length && <p className={styles.empty}>No recent recorded events. Quiet or unconnected does not mean healthy.</p>}</section>
  </section>
}
