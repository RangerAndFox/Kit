'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Activity, FolderKanban, Gauge, MessageSquareText, Settings, Zap } from 'lucide-react'

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
      <aside className="hidden w-[228px] shrink-0 flex-col border-r border-white/[0.12] bg-[#08090a] md:sticky md:top-0 md:flex md:h-screen">
        <Link href="/control-center" className="flex h-[88px] items-center gap-3 border-b border-white/[0.12] px-5 transition hover:bg-white/[0.025]">
          <Image src="/kit-icon.png" alt="Kit" width={46} height={46} className="h-[46px] w-[46px]" priority />
          <div>
            <div className="font-['RF_Plaak',Arial_Narrow,sans-serif] text-xl font-black uppercase leading-none tracking-[-0.04em] text-[#f0f2f5]">Kit</div>
            <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-[#707985]">Studio system</div>
          </div>
        </Link>
        <div className="flex items-center justify-between border-b border-white/[0.12] px-5 py-3 font-mono text-[9px] uppercase tracking-[0.16em] text-[#626b75]">
          <span>Navigation</span><span>SYS / 01</span>
        </div>
        <nav className="flex-1" aria-label="Kit navigation">
          {links.map((link) => {
            const active = pathname === link.href || (link.href !== '/control-center' && pathname.startsWith(`${link.href}/`))
            const Icon = link.icon
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`group flex min-h-[52px] items-center gap-3 border-b border-white/[0.08] px-5 text-sm transition ${active ? 'bg-[#00ff66] text-[#08090a]' : 'text-[#8a939e] hover:bg-white/[0.035] hover:text-[#f0f2f5]'}`}
              >
                <Icon size={16} strokeWidth={1.6} aria-hidden="true" />
                <span className="flex-1">{link.label}</span>
                <span className={`font-mono text-[9px] ${active ? 'text-[#08090a]/60' : 'text-[#4f5761] group-hover:text-[#7f8994]'}`}>0{links.indexOf(link) + 1}</span>
              </Link>
            )
          })}
        </nav>
        <div className="border-t border-white/[0.12] p-5 font-mono text-[9px] uppercase leading-5 tracking-[0.12em] text-[#626b75]">
          Ranger &amp; Fox<br /><span className="text-[#00ff66]">Detroit + distributed</span>
        </div>
      </aside>
      <nav className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-around border-t border-white/[0.12] bg-[#08090a]/95 px-2 py-2 backdrop-blur md:hidden" aria-label="Kit mobile navigation">
        {links.slice(0, 5).map((link) => {
          const active = pathname === link.href || (link.href !== '/control-center' && pathname.startsWith(`${link.href}/`))
          const Icon = link.icon
          return (
            <Link key={link.href} href={link.href} className={`flex min-w-14 flex-col items-center gap-1 px-2 py-1 text-[10px] ${active ? 'text-[#00ff66]' : 'text-[#767e8f]'}`}>
              <Icon size={17} aria-hidden="true" />
              {link.label.replace('Control Center', 'Control')}
            </Link>
          )
        })}
      </nav>
    </>
  )
}
