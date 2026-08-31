'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Calendar, Plus } from 'lucide-react'

interface Project {
  milestones: Array<{
    id: string
    name: string
    due_date: Date
    status: string
    progress: number
  }>
}

export function ScheduleTab({ project }: { project: Project }) {
  const statusColors: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
    completed: 'success',
    in_progress: 'info',
    pending: 'default',
    overdue: 'danger',
  }

  return (
    <div className="p-6 md:p-8 lg:p-12 max-w-7xl mx-auto space-y-8">
      {/* Milestone Timeline */}
      <Card className="kit-card">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Milestone Timeline</CardTitle>
          <Button size="sm" variant="primary" className="gap-2">
            <Plus className="w-4 h-4" />
            Add Milestone
          </Button>
        </CardHeader>
        <CardContent>
          <div className="relative space-y-6">
            {/* Timeline line */}
            <div className="absolute left-6 top-0 bottom-0 w-0.5 bg-gradient-to-b from-indigo-500 to-transparent" />

            {project.milestones.map((milestone, index) => {
              const isOverdue = milestone.status === 'overdue'

              const color: Record<string, string> = {
                completed: 'emerald-500',
                in_progress: 'indigo-500',
                pending: 'gray-400',
                overdue: 'red-500',
              }

              return (
                <div key={milestone.id} className="flex gap-6 relative pl-12">
                  {/* Timeline dot */}
                  <div
                    className={`absolute left-0 top-1 w-4 h-4 rounded-full border-2 border-[#0C0E12] bg-${
                      isOverdue ? 'red-500' : color[milestone.status]
                    } z-10`}
                  />

                  {/* Content */}
                  <div className="flex-1 pt-1">
                    <div className="flex items-start justify-between gap-4 mb-3">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-white text-lg">{milestone.name}</h3>
                        <div className="flex items-center gap-2 mt-2 text-sm text-[#9ca3af]">
                          <Calendar className="w-4 h-4" />
                          {milestone.due_date.toLocaleDateString('en-US', {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                          {isOverdue && (
                            <span className="text-red-400 font-medium">
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
                    <div className="w-full bg-[#181B24] rounded-full h-2 overflow-hidden">
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
                    <p className="text-xs text-[#6b7280] mt-2">{milestone.progress}% complete</p>
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Workback Schedule Card */}
      <Card className="kit-card">
        <CardHeader>
          <CardTitle>Workback Confidence</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <div className="flex justify-between items-end mb-2">
                <span className="text-sm text-white">Schedule Confidence</span>
                <span className="text-lg font-bold text-indigo-400">82%</span>
              </div>
              <div className="w-full bg-[#181B24] rounded-full h-3 overflow-hidden">
                <div className="h-full w-4/5 bg-gradient-to-r from-indigo-500 to-indigo-600" />
              </div>
              <p className="text-xs text-[#9ca3af] mt-3">
                Based on team availability, dependencies, and historical velocity. Minor risks on color grade scheduling.
              </p>
            </div>

            <div className="pt-4 border-t border-[#2a2f3d]">
              <h4 className="text-sm font-semibold text-white mb-3">Schedule Risks</h4>
              <ul className="space-y-2 text-sm text-[#9ca3af]">
                <li className="flex gap-2">
                  <span className="text-amber-400">⚠</span>
                  <span>Color grade facility availability - booking window closing soon</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-blue-400">ℹ</span>
                  <span>VFX artist vacation scheduled during VFX phase - contingency planned</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-green-400">✓</span>
                  <span>Client review cycle well-defined with clear feedback windows</span>
                </li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Critical Path Info */}
      <Card className="kit-card">
        <CardHeader>
          <CardTitle>Critical Path</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <p className="text-sm text-[#9ca3af]">
              The following sequence is on the critical path and cannot slip:
            </p>
            <div className="bg-[#181B24] rounded-lg p-4">
              <div className="flex items-center justify-between gap-2 text-sm font-mono text-white">
                <span>Animatic Review</span>
                <span className="text-[#6b7280]">→</span>
                <span>Production Start</span>
                <span className="text-[#6b7280]">→</span>
                <span>Color Grade</span>
                <span className="text-[#6b7280]">→</span>
                <span>Final Delivery</span>
              </div>
            </div>
            <p className="text-xs text-[#6b7280]">
              Total critical path duration: 40 days. Any delay in Animatic Review cascades to final delivery.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
