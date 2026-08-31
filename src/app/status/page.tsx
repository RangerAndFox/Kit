'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

export default function StatusPage() {
  const [online, setOnline] = useState<boolean | null>(null)
  const [checkedAt, setCheckedAt] = useState<string>('')
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/status', { cache: 'no-store' })
      const payload = await response.json()
      setOnline(response.ok && payload.ok === true)
      setCheckedAt(new Date(payload.checkedAt || Date.now()).toLocaleTimeString())
    } catch {
      setOnline(false)
      setCheckedAt(new Date().toLocaleTimeString())
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [load])

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#08090a] px-6 text-[#f0f2f5]">
      <section className="w-full max-w-2xl border border-white/15 bg-white/[0.025] p-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#00ff66]">Ranger &amp; Fox / Kit</p>
        <h1 className="mt-4 text-4xl font-semibold">Service status</h1>
        <div className="mt-8 flex items-center gap-4 border-y border-white/10 py-5">
          <span className={`h-3 w-3 rounded-full ${online === null ? 'bg-[#777f90]' : online ? 'bg-[#00ff66]' : 'bg-[#ff5c4d]'}`} />
          <div>
            <p className="text-lg">{online === null ? 'Checking Kit…' : online ? 'Kit web service is online' : 'Kit web service is unavailable'}</p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[#777f90]">{checkedAt ? `Last checked ${checkedAt}` : 'Public liveness only'}</p>
          </div>
        </div>
        <p className="mt-6 leading-7 text-[#9aa3ad]">Provider credentials, internal errors, queues, and scheduled-job details are intentionally not exposed on this public page. Authorized founders can review the full health picture in the Control Center.</p>
        <Link href="/control-center" className="mt-7 inline-flex border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-[0.12em] hover:border-[#00ff66]">Open Control Center</Link>
      </section>
    </main>
  )
}
