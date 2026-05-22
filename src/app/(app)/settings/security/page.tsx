'use client'
import { useState } from 'react'

interface RoutingRule { id: string; type: string; pattern: string; stream: string }

const mockRules: RoutingRule[] = [
  { id: '1', type: 'keyword', pattern: '[private]', stream: 'founder' },
  { id: '2', type: 'keyword', pattern: '[founder]', stream: 'founder' },
  { id: '3', type: 'domain', pattern: 'plaud.ai', stream: 'founder' },
]

const mockAuditLog = [
  { id: '1', action: 'Viewed', content: 'Founder strategy transcript', user: 'Stephen Fox', at: '2026-04-11 09:15' },
  { id: '2', action: 'Searched', content: 'Revenue projections Q2', user: 'Stephen Fox', at: '2026-04-10 14:30' },
  { id: '3', action: 'Viewed', content: 'Investor call notes', user: 'Stephen Fox', at: '2026-04-09 11:22' },
  { id: '4', action: 'Exported', content: 'Financial summary deck', user: 'Stephen Fox', at: '2026-04-08 16:45' },
  { id: '5', action: 'Viewed', content: 'Team salary planning doc', user: 'Stephen Fox', at: '2026-04-07 10:10' },
]

export default function SecuritySettingsPage() {
  const [rules, setRules] = useState(mockRules)
  const [newType, setNewType] = useState('keyword')
  const [newPattern, setNewPattern] = useState('')
  const [newStream, setNewStream] = useState('founder')

  const addRule = () => {
    if (!newPattern.trim()) return
    setRules(prev => [...prev, { id: String(Date.now()), type: newType, pattern: newPattern, stream: newStream }])
    setNewPattern('')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Security</h2>
        <p className="text-sm text-[#9ca3af] mt-1">Founder-only transcription routing and audit log</p>
      </div>
      <div className="bg-[#181B24] rounded-xl p-6 space-y-4">
        <h3 className="text-sm font-medium text-white">Transcription Routing Rules</h3>
        <div className="space-y-2">
          {rules.map(r => (
            <div key={r.id} className="flex items-center justify-between bg-[#0C0E12] rounded-lg px-4 py-2">
              <div className="flex items-center gap-3">
                <span className="px-2 py-0.5 rounded text-xs bg-[#2a2f3d] text-[#9ca3af]">{r.type}</span>
                <span className="text-sm text-white font-mono">{r.pattern}</span>
                <span className="text-xs text-[#9ca3af]">&#8594;</span>
                <span className={`px-2 py-0.5 rounded text-xs ${r.stream === 'founder' ? 'bg-[#6366F1]/20 text-[#6366F1]' : 'bg-[#10B981]/20 text-[#10B981]'}`}>{r.stream}</span>
              </div>
              <button onClick={() => setRules(prev => prev.filter(x => x.id !== r.id))} className="text-xs text-[#EF4444] hover:text-[#EF4444]/80">Remove</button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <select value={newType} onChange={e => setNewType(e.target.value)} className="bg-[#0C0E12] border border-[#2a2f3d] rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none">
            <option value="keyword">keyword</option><option value="domain">domain</option><option value="sender">sender</option>
          </select>
          <input type="text" placeholder="Pattern..." value={newPattern} onChange={e => setNewPattern(e.target.value)} className="flex-1 bg-[#0C0E12] border border-[#2a2f3d] rounded-lg px-3 py-1.5 text-white text-xs focus:border-[#6366F1] focus:outline-none" />
          <select value={newStream} onChange={e => setNewStream(e.target.value)} className="bg-[#0C0E12] border border-[#2a2f3d] rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none">
            <option value="founder">founder</option><option value="team">team</option>
          </select>
          <button onClick={addRule} className="px-3 py-1.5 bg-[#6366F1] text-white rounded-lg text-xs font-medium">Add</button>
        </div>
      </div>
      <div className="bg-[#181B24] rounded-xl p-6">
        <h3 className="text-sm font-medium text-white mb-3">Content Access Audit Log</h3>
        <table className="w-full">
          <thead><tr className="border-b border-[#2a2f3d]">
            <th className="text-left text-xs text-[#9ca3af] pb-2">Action</th>
            <th className="text-left text-xs text-[#9ca3af] pb-2">Content</th>
            <th className="text-left text-xs text-[#9ca3af] pb-2">User</th>
            <th className="text-left text-xs text-[#9ca3af] pb-2">When</th>
          </tr></thead>
          <tbody>
            {mockAuditLog.map(e => (
              <tr key={e.id} className="border-b border-[#2a2f3d]/30">
                <td className="py-2 text-xs text-white">{e.action}</td>
                <td className="py-2 text-xs text-[#9ca3af]">{e.content}</td>
                <td className="py-2 text-xs text-[#9ca3af]">{e.user}</td>
                <td className="py-2 text-xs text-[#9ca3af] font-mono">{e.at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
