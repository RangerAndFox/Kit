'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AlertCircle, CheckCircle2, Link as LinkIcon } from 'lucide-react'
import { useState } from 'react'

interface Project {
  feedback_items: Array<{
    id: string
    content: string
    source: string
    source_url?: string
    sentiment: string
    priority: string
    status: string
    date: Date
  }>
}

export function FeedbackTab({ project }: { project: Project }) {
  const [filters, setFilters] = useState({
    sentiment: 'all',
    status: 'all',
    priority: 'all',
  })

  const filteredFeedback = project.feedback_items.filter((item) => {
    if (filters.sentiment !== 'all' && item.sentiment !== filters.sentiment) return false
    if (filters.status !== 'all' && item.status !== filters.status) return false
    if (filters.priority !== 'all' && item.priority !== filters.priority) return false
    return true
  })

  const scopeCreepDetected = project.feedback_items.some(
    (item) =>
      item.content.toLowerCase().includes('add') ||
      item.content.toLowerCase().includes('additional') ||
      item.content.toLowerCase().includes('more')
  )

  const sentimentColors: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
    positive: 'success',
    neutral: 'default',
    negative: 'warning',
  }

  const priorityColors: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
    low: 'default',
    medium: 'warning',
    high: 'danger',
    critical: 'danger',
  }

  const statusColors: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
    new: 'info',
    in_progress: 'info',
    resolved: 'success',
  }

  return (
    <div className="p-6 md:p-8 lg:p-12 max-w-7xl mx-auto space-y-8">
      {/* Scope Creep Alert */}
      {scopeCreepDetected && (
        <Card className="kit-card border border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-6 flex gap-3">
            <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-amber-300">Potential Scope Creep Detected</p>
              <p className="text-sm text-amber-200/70 mt-1">
                Some feedback items suggest additional requests beyond original scope. Review and prioritize accordingly.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="bg-[#181B24] rounded-lg p-4 space-y-4">
        <h3 className="text-sm font-semibold text-white">Filter Feedback</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Sentiment Filter */}
          <div>
            <label className="text-xs font-medium text-[#9ca3af] mb-2 block">Sentiment</label>
            <div className="flex gap-2 flex-wrap">
              {['all', 'positive', 'neutral', 'negative'].map((value) => (
                <button
                  key={value}
                  onClick={() => setFilters({ ...filters, sentiment: value })}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    filters.sentiment === value
                      ? 'bg-indigo-600 text-white'
                      : 'bg-[#0C0E12] text-[#9ca3af] hover:text-white'
                  }`}
                >
                  {value.charAt(0).toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Status Filter */}
          <div>
            <label className="text-xs font-medium text-[#9ca3af] mb-2 block">Status</label>
            <div className="flex gap-2 flex-wrap">
              {['all', 'new', 'in_progress', 'resolved'].map((value) => (
                <button
                  key={value}
                  onClick={() => setFilters({ ...filters, status: value })}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    filters.status === value
                      ? 'bg-indigo-600 text-white'
                      : 'bg-[#0C0E12] text-[#9ca3af] hover:text-white'
                  }`}
                >
                  {value === 'in_progress' ? 'In Progress' : value.charAt(0).toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Priority Filter */}
          <div>
            <label className="text-xs font-medium text-[#9ca3af] mb-2 block">Priority</label>
            <div className="flex gap-2 flex-wrap">
              {['all', 'low', 'medium', 'high'].map((value) => (
                <button
                  key={value}
                  onClick={() => setFilters({ ...filters, priority: value })}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    filters.priority === value
                      ? 'bg-indigo-600 text-white'
                      : 'bg-[#0C0E12] text-[#9ca3af] hover:text-white'
                  }`}
                >
                  {value.charAt(0).toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Feedback Items */}
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-semibold text-white">Feedback Items</h2>
          <p className="text-sm text-[#9ca3af]">
            {filteredFeedback.length} of {project.feedback_items.length} items
          </p>
        </div>

        <div className="space-y-4">
          {filteredFeedback.length > 0 ? (
            filteredFeedback.map((item) => (
              <Card key={item.id} className="kit-card hover:border-[#3a3f4d] transition-colors">
                <CardContent className="pt-6">
                  <div className="space-y-4">
                    {/* Content and Meta */}
                    <div>
                      <p className="text-white leading-relaxed">{item.content}</p>
                      <div className="flex items-center gap-2 mt-3">
                        <span className="text-xs text-[#9ca3af]">{item.source}</span>
                        {item.source_url && (
                          <a
                            href={item.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-indigo-400 hover:text-indigo-300 transition-colors"
                          >
                            <LinkIcon className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </div>

                    {/* Badges and Actions */}
                    <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-[#2a2f3d]">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge
                          variant={
                            sentimentColors[item.sentiment] as 'default' | 'success' | 'warning' | 'danger' | 'info'
                          }
                          size="sm"
                        >
                          {item.sentiment}
                        </Badge>
                        <Badge
                          variant={
                            priorityColors[item.priority] as 'default' | 'success' | 'warning' | 'danger' | 'info'
                          }
                          size="sm"
                        >
                          {item.priority}
                        </Badge>
                        <Badge
                          variant={statusColors[item.status] as 'default' | 'success' | 'warning' | 'danger' | 'info'}
                          size="sm"
                        >
                          {item.status === 'in_progress' ? 'In Progress' : item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                        </Badge>
                      </div>

                      <div className="flex items-center gap-3">
                        <span className="text-xs text-[#6b7280]">
                          {item.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </span>
                        <div className="flex gap-2">
                          <Button size="sm" variant="ghost">
                            {item.status === 'resolved' ? (
                              <>
                                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                              </>
                            ) : (
                              <>
                                Acknowledge
                              </>
                            )}
                          </Button>
                          {item.status !== 'resolved' && (
                            <Button size="sm" variant="ghost">
                              Resolve
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <Card className="kit-card">
              <CardContent className="pt-6">
                <p className="text-center text-[#9ca3af]">No feedback items match your filters</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
