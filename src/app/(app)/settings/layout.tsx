'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { cn } from '@/lib/utils'

const settingsTabs = [
  { label: 'Team', href: '/settings/team' },
  { label: 'Integration health', href: '/control-center' },
]

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-8 py-8">
        <div className="max-w-7xl">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">Settings</h1>
            <p className="text-[#9ca3af]">Verified workspace information. Manage access through Kit in Slack.</p>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-[#2a2f3d] mb-8 overflow-x-auto">
            {settingsTabs.map((tab) => (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  'px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors',
                  pathname === tab.href
                    ? 'border-indigo-600 text-white'
                    : 'border-transparent text-[#9ca3af] hover:text-white'
                )}
              >
                {tab.label}
              </Link>
            ))}
          </div>

          {/* Content */}
          <div>
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
