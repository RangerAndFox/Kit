'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Activity, Bot, FolderKanban, Gauge, MessageSquareText, Settings, Zap } from 'lucide-react'

const links = [
  { href: '/control-center', label: 'Control Center', icon: Gauge },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/actions', label: 'Actions', icon: Zap },
  { href: '/ask', label: 'Ask Kit', icon: MessageSquareText },
  { href: '/studio-ops/farm', label: 'Render Farm', icon: Activity },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export function AppNavigation() {
  const pathname = usePathname()

  return (
    <>
      <aside className="hidden w-64 shrink-0 flex-col border-r border-white/[0.08] bg-[#11141b] md:flex">
        <Link href="/control-center" className="flex items-center gap-3 border-b border-white/[0.08] px-6 py-6">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500 text-white shadow-lg shadow-indigo-950/40"><Bot size={19} /></span>
          <div><div className="text-base font-semibold tracking-tight text-white">Kit</div><div className="text-[11px] uppercase tracking-[0.15em] text-[#697183]">Studio OS</div></div>
        </Link>
        <nav className="flex-1 space-y-1 p-3" aria-label="Kit navigation">
          {links.map((link) => {
            const active = pathname === link.href || (link.href !== '/control-center' && pathname.startsWith(`${link.href}/`))
            const Icon = link.icon
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${active ? 'bg-indigo-500/15 text-indigo-200' : 'text-[#8c94a5] hover:bg-white/[0.04] hover:text-white'}`}
              >
                <Icon size={17} aria-hidden="true" />
                {link.label}
              </Link>
            )
          })}
        </nav>
        <div className="border-t border-white/[0.08] p-5 text-xs leading-5 text-[#626b7b]">
          Founder operations<br />Ranger &amp; Fox
        </div>
      </aside>
      <nav className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-around border-t border-white/10 bg-[#11141b]/95 px-2 py-2 backdrop-blur md:hidden" aria-label="Kit mobile navigation">
        {links.slice(0, 5).map((link) => {
          const active = pathname === link.href || (link.href !== '/control-center' && pathname.startsWith(`${link.href}/`))
          const Icon = link.icon
          return (
            <Link key={link.href} href={link.href} className={`flex min-w-14 flex-col items-center gap-1 rounded-md px-2 py-1 text-[10px] ${active ? 'text-indigo-300' : 'text-[#767e8f]'}`}>
              <Icon size={17} aria-hidden="true" />
              {link.label.replace('Control Center', 'Control')}
            </Link>
          )
        })}
      </nav>
    </>
  )
}
