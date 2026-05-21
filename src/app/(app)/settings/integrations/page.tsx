'use client'
import { useState } from 'react'

const integrations = [
  { name: 'Slack', category: 'Communication', description: 'Team messaging and notifications', connected: true },
  { name: 'Google Calendar', category: 'Calendar', description: 'Meeting detection and prep briefs', connected: true },
  { name: 'Clockify', category: 'Time Tracking', description: 'Automatic time entry sync', connected: true },
  { name: 'Frame.io', category: 'Creative', description: 'Feedback and review sync', connected: true },
  { name: 'Figma', category: 'Creative', description: 'Design file monitoring', connected: false },
  { name: 'Plaud', category: 'Transcription', description: 'Hardware AI recorder — meeting transcripts via webhook (https://docs.plaud.ai/)', connected: false },
  { name: 'Otter.ai', category: 'Transcription', description: 'Team meeting transcripts', connected: false },
  { name: 'Vimeo', category: 'Video', description: 'Video hosting and delivery', connected: false },
  { name: 'QuickBooks', category: 'Finance', description: 'Invoice and expense tracking', connected: false },
  { name: 'Google Drive', category: 'Storage', description: 'Document storage and access', connected: false },
  { name: 'Gmail', category: 'Communication', description: 'Email thread monitoring', connected: false },
  { name: 'Notion', category: 'Project Management', description: 'Bidirectional project sync', connected: false },
]

export default function IntegrationsSettingsPage() {
  const [connections, setConnections] = useState<Record<string, boolean>>(
    Object.fromEntries(integrations.map(i => [i.name, i.connected]))
  )
  const categories = Array.from(new Set(integrations.map(i => i.category)))

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Integrations</h2>
        <p className="text-sm text-[#9ca3af] mt-1">Connect your tools to Kit</p>
      </div>
      {categories.map(cat => (
        <div key={cat}>
          <h3 className="text-sm font-medium text-[#9ca3af] mb-3">{cat}</h3>
          <div className="space-y-2">
            {integrations.filter(i => i.category === cat).map(i => (
              <div key={i.name} className="bg-[#181B24] rounded-xl px-5 py-4 flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-white">{i.name}</div>
                  <div className="text-xs text-[#9ca3af]">{i.description}</div>
                </div>
                <button
                  onClick={() => setConnections(prev => ({ ...prev, [i.name]: !prev[i.name] }))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    connections[i.name]
                      ? 'bg-[#10B981]/20 text-[#10B981]'
                      : 'bg-[#2a2f3d] text-[#9ca3af] hover:text-white'
                  }`}
                >
                  {connections[i.name] ? 'Connected' : 'Connect'}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
