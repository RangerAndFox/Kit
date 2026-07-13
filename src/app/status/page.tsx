'use client'

/**
 * /status — live health page. Polls /api/status every 30s and renders a
 * green/amber/red board. Standalone (outside the app's auth group) so it can
 * double as a quick internal uptime glance.
 */

import { useEffect, useState, useCallback, type CSSProperties } from 'react'

interface Check {
  key: string
  label: string
  ok: boolean
  detail?: string
}
interface StatusPayload {
  ok: boolean
  checkedAt: string
  checks: Check[]
  error?: string
}

const REFRESH_MS = 30_000

export default function StatusPage() {
  const [data, setData] = useState<StatusPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' })
      const json = (await res.json()) as StatusPayload
      setData(json)
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
      setFetchedAt(new Date())
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  const integrations = (data?.checks || []).filter((c) => !c.key.startsWith('cron:'))
  const crons = (data?.checks || []).filter((c) => c.key.startsWith('cron:'))
  const allOk = data?.ok ?? false
  const banner = failed
    ? { color: '#8a929b', text: 'Status endpoint unreachable' }
    : allOk
      ? { color: '#2e7d57', text: 'All systems operational' }
      : { color: '#b4531f', text: 'Degraded — one or more checks failing' }

  return (
    <main style={S.page}>
      <style>{globalCss}</style>
      <div style={S.wrap}>
        <header style={S.head}>
          <p style={S.eyebrow}>Ranger &amp; Fox · Kit</p>
          <h1 style={S.title}>System status</h1>
          <div style={{ ...S.banner, borderColor: banner.color }}>
            <span style={{ ...S.bannerDot, background: banner.color }} />
            <span style={{ color: banner.color, fontWeight: 600 }}>{banner.text}</span>
          </div>
          <p style={S.meta}>
            {loading && !data ? 'Checking…' : fetchedAt ? `Updated ${fetchedAt.toLocaleTimeString()}` : ''}
            {fetchedAt ? ' · refreshes every 30s' : ''}
          </p>
        </header>

        {data?.error ? <p style={S.err}>Probe error: {data.error}</p> : null}

        <Section title="Integrations" checks={integrations} />
        <Section title="Scheduled jobs" checks={crons} />

        <footer style={S.foot}>
          Live checks of Kit&apos;s connections and background jobs. Red means broken; amber-grey means
          the status couldn&apos;t be read. Alerts also post to the ops channel the moment anything flips.
        </footer>
      </div>
    </main>
  )
}

function Section({ title, checks }: { title: string; checks: Check[] }) {
  if (checks.length === 0) return null
  return (
    <section style={{ marginTop: '2rem' }}>
      <h2 style={S.sectionTitle}>{title}</h2>
      <div style={S.list}>
        {checks.map((c) => {
          const color = c.ok ? '#2e7d57' : '#c6402e'
          return (
            <div key={c.key} style={S.row}>
              <span style={{ ...S.dot, background: color }} />
              <span style={S.label}>{c.label}</span>
              <span style={S.detail}>{c.detail || (c.ok ? 'ok' : 'failing')}</span>
              <span style={{ ...S.pill, color, borderColor: color }}>{c.ok ? 'UP' : 'DOWN'}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

const globalCss = `
  :root { color-scheme: light dark; }
  body { margin: 0; }
  * { box-sizing: border-box; }
`

const S: Record<string, CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg, #f4f5f6)',
    color: '#1a2026',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    padding: '3rem 1.25rem',
  },
  wrap: { maxWidth: 720, margin: '0 auto' },
  head: { borderBottom: '1px solid #cfd4d8', paddingBottom: '1.5rem' },
  eyebrow: {
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: '.72rem',
    letterSpacing: '.22em',
    textTransform: 'uppercase',
    color: '#a8481c',
    margin: '0 0 .6rem',
  },
  title: { fontFamily: 'Georgia, serif', fontSize: '2.4rem', margin: '0 0 1rem', letterSpacing: '-.01em' },
  banner: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '.6rem',
    border: '1px solid',
    borderRadius: 999,
    padding: '.4rem .9rem',
    background: '#fff',
  },
  bannerDot: { width: '.7rem', height: '.7rem', borderRadius: '50%' },
  meta: { fontSize: '.82rem', color: '#6b757e', marginTop: '.9rem' },
  err: { color: '#c6402e', fontSize: '.85rem', marginTop: '1rem' },
  sectionTitle: {
    fontFamily: 'Georgia, serif',
    fontSize: '1.2rem',
    margin: '0 0 .8rem',
  },
  list: { display: 'flex', flexDirection: 'column', gap: '.5rem' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '.75rem',
    background: '#fff',
    border: '1px solid #e0e3e6',
    borderRadius: 10,
    padding: '.8rem 1rem',
  },
  dot: { width: '.7rem', height: '.7rem', borderRadius: '50%', flex: 'none' },
  label: { fontWeight: 600, minWidth: 150 },
  detail: {
    flex: 1,
    fontSize: '.82rem',
    color: '#6b757e',
    fontFamily: 'ui-monospace, Menlo, monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  pill: {
    fontSize: '.66rem',
    fontWeight: 700,
    letterSpacing: '.08em',
    border: '1px solid',
    borderRadius: 999,
    padding: '.2rem .5rem',
    flex: 'none',
  },
  foot: { marginTop: '2.5rem', fontSize: '.8rem', color: '#6b757e', lineHeight: 1.5 },
}
