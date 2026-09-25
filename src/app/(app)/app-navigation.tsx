'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { FolderKanban, Gauge, LockKeyhole, Settings, Smile } from 'lucide-react'
import styles from './app-shell.module.css'

const links = [
  { href: '/control-center', label: 'Control Center', icon: Gauge },
  { href: '/culture-center', label: 'Culture Center', icon: Smile },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/settings', label: 'Settings', icon: Settings },
]
export function AppNavigation() {
  const pathname = usePathname()
  const navigation = links.map(link => {
    const active = pathname === link.href || pathname.startsWith(link.href + '/')
    const Icon = link.icon
    return <Link key={link.href} href={link.href} aria-current={active ? 'page' : undefined} className={styles.navItem + (active ? ' ' + styles.active : '')}>
      <Icon size={17} strokeWidth={1.6} aria-hidden="true" /><span>{link.label}</span>
    </Link>
  })
  return <>
    <aside className={styles.sidebar}>
      <Link href="/control-center" className={styles.brand} aria-label="Kit home">
        <Image src="/kit-icon.png" alt="" width={32} height={32} priority />
        <span>Kit <small>Ranger &amp; Fox</small></span>
      </Link>
      <p className={styles.sectionLabel}>Workspace</p>
      <nav className={styles.navigation} aria-label="Kit navigation">{navigation}</nav>
      <div className={styles.footer}><LockKeyhole size={15} aria-hidden="true" /><div>Admin workspace<small>Private to studio leadership</small></div></div>
    </aside>
    <nav className={styles.mobileNav} aria-label="Kit mobile navigation">{navigation}</nav>
  </>
}
