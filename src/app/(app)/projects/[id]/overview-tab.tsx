'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Calendar, AlertCircle, MessageSquare } from 'lucide-react'

interface Project {
  id: string
  name: string
  client_name: string
  project_code: string
  status: string
  health: string
  budget: number
  spent: number
  daysRemaining: number
  revisionsUsed: number
  revisionsTotal: number
  healthScore: number
  milestones: Array<{
    id: string
    name: string
    due_date: Date
    status: string
    progress: number
  }>
  brief: string
  pending_actions: Array<{
    id: string
    title: string
    due_date: Date
    priority: string
  }>
  recent_feedback: Array<{
    id: string
    content: string
    source: string
    sentiment: string
    date: Date
  }>
}

export function OverviewTab({ project }: { project: Project }) {
  // Calculate remaining budget
  const budgetRemaining = project.budget - project.spent

  return (
    <div className="p-6 md:p-8 lg:p-12 max-w-7xl mx-auto space-y-8">
      {/* Key Metrics Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="kit-card">
          <CardContent className="pt-6">
            <p className="text-xs text-[#9ca3af] mb-2">Budget Remaining</p>
            <p className="text-2xl font-bold text-emerald-400 font-mono">
              ${budgetRemaining.toLocaleString()}
            </p>
            <p className="text-xs text-[#6b7280] mt-1">
              {Math.round((budgetRemaining / project.budget) * 100)}% available
            </p>
          </CardContent>
        </Card>

        <Card className="kit-card">
          <CardContent className="pt-6">
            <p className="text-xs text-[#9ca3af] mb-2">Days Remaining</p>
            <p className="text-2xl font-bold text-indigo-400">{project.daysRemaining}</p>
            <p className="text-xs text-[#6b7280] mt-1">Until final delivery</p>
          </CardContent>
        </Card>

        <Card className="kit-card">
          <CardContent className="pt-6">
            <p className="text-xs text-[#9ca3af] mb-2">Revisions Used</p>
            <p className="text-2xl font-bold text-white">
              {project.revisionsUsed} <span className="text-sm text-[#6b7280]">/ {project.revisionsTotal}</span>
            </p>
            <p className="text-xs text-[#6b7280] mt-1">
              {project.revisionsTotal - project.revisionsUsed} remaining
            </p>
          </CardContent>
        </Card>

        <Card className="kit-card">
          <CardContent className="pt-6">
            <p className="text-xs text-[#9ca3af] mb-2">Health Score</p>
            <p className={`text-2xl font-bold ${
              project.healthScore > 80 ? 'text-emerald-400' :
              project.healthScore > 60 ? 'text-amber-400' :
              'text-red-400'
            }`}>
              {project.healthScore}%
            </p>
            <p className="text-xs text-[#6b7280] mt-1">Project status</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Active Milestones */}
        <div className="lg:col-span-2 space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-white mb-4">Active Milestones</h2>
            <div className="space-y-3">
              {project.milestones.slice(0, 4).map((milestone) => {
                const isOverdue = milestone.status === 'overdue'

                const statusColors: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
                  completed: 'success',
                  in_progress: 'info',
                  pending: 'default',
                  overdue: 'danger',
                }

                return (
                  <Card key={milestone.id} className="kit-card">
                    <CardContent className="pt-6">
                      <div className="flex items-start justify-between gap-4 mb-3">
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium text-white truncate">{milestone.name}</h3>
                          <div className="flex items-center gap-2 mt-2 text-xs text-[#9ca3af]">
                            <Calendar className="w-3 h-3" />
                            {milestone.due_date.toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                            })}
                            {isOverdue && (
                              <span className="text-red-400 ml-1">
                                (overdue)
                              </span>
                            )}
                          </div>
                        </div>
                        <Badge
                          variant={
                            isOverdue
                              ? 'danger'
                              : (statusColors[milestone.status] as 'default' | 'success' | 'warning' | 'danger' | 'info')
                          }
                          size="sm"
                        >
                          {milestone.status === 'in_progress'
                            ? 'In Progress'
                            : milestone.status === 'pending'
                            ? 'Pending'
                            : 'Completed'}
                        </Badge>
                      </div>

                      {/* Progress bar */}
                      <div className="w-full bg-[#181B24] rounded-full h-1.5 overflow-hidden">
                        <div
                          className={`h-full transition-all ${
                            milestone.status === 'completed'
                              ? 'bg-emerald-500'
                              : milestone.status === 'in_progress'
                              ? 'bg-indigo-500'
                              : 'bg-[#2a2f3d]'
                          }`}
                          style={{ width: `${milestone.progress}%` }}
                        />
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          {/* Project Brief */}
          <Card className="kit-card">
            <CardHeader>
              <CardTitle className="text-base">Project Brief</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-[#9ca3af] leading-relaxed">{project.brief}</p>
            </CardContent>
          </Card>

          {/* Pending Actions */}
          <Card className="kit-card">
            <CardHeader>
              <CardTitle className="text-base">Pending Actions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {project.pending_actions.slice(0, 3).map((action) => (
                  <div key={action.id} className="text-sm">
                    <p className="text-white font-medium mb-1">{action.title}</p>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[#9ca3af]">
                        Due {action.due_date.toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                      <Badge
                        variant={
                          action.priority === 'high'
                            ? 'danger'
                            : action.priority === 'medium'
                            ? 'warning'
                            : 'default'
                        }
                        size="sm"
                      >
                        {action.priority}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Recent Feedback */}
      <div>
        <h2 className="text-xl font-semibold text-white mb-4">Recent Feedback</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {project.recent_feedback.map((feedback) => {
            const sentimentColors: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
              positive: 'success',
              neutral: 'default',
              negative: 'warning',
            }

            return (
              <Card key={feedback.id} className="kit-card">
                <CardContent className="pt-6">
                  <div className="flex gap-2 mb-3">
                    <MessageSquare className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white leading-relaxed">{feedback.content}</p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-3 border-t border-[#2a2f3d]">
                    <p className="text-xs text-[#9ca3af] truncate">{feedback.source}</p>
                    <Badge
                      variant={sentimentColors[feedback.sentiment] as 'default' | 'success' | 'warning' | 'danger' | 'info'}
                      size="sm"
                    >
                      {feedback.sentiment}
                    </Badge>
                  </div>

                  <p className="text-xs text-[#6b7280] mt-2">
                    {feedback.date.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </p>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>
    </div>
  )
}
