'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ExternalLink, Plus, GripVertical } from 'lucide-react'
import { useState } from 'react'

interface Project {
  deliverables: Array<{
    id: string
    title: string
    status: string
    format: string
    delivery_url: string
    specs: Record<string, string>
  }>
}

export function DeliverablesTab({ project }: { project: Project }) {
  const [deliverables, setDeliverables] = useState(project.deliverables)
  const [isAddingNew, setIsAddingNew] = useState(false)

  const statusCycle = [
    'not_started',
    'in_progress',
    'internal_review',
    'client_review',
    'approved',
    'delivered',
  ]

  const statusColors: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
    not_started: 'default',
    in_progress: 'info',
    internal_review: 'warning',
    client_review: 'warning',
    approved: 'success',
    delivered: 'success',
  }

  const statusLabels: Record<string, string> = {
    not_started: 'Not Started',
    in_progress: 'In Progress',
    internal_review: 'Internal Review',
    client_review: 'Client Review',
    approved: 'Approved',
    delivered: 'Delivered',
  }

  const handleStatusClick = (deliverableId: string) => {
    setDeliverables(
      deliverables.map((d) => {
        if (d.id === deliverableId) {
          const currentIndex = statusCycle.indexOf(d.status)
          const nextStatus = statusCycle[(currentIndex + 1) % statusCycle.length]
          return { ...d, status: nextStatus }
        }
        return d
      })
    )
  }

  return (
    <div className="p-6 md:p-8 lg:p-12 max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold text-white">Deliverables</h2>
        <Button
          size="sm"
          variant="primary"
          className="gap-2"
          onClick={() => setIsAddingNew(!isAddingNew)}
        >
          <Plus className="w-4 h-4" />
          Add Deliverable
        </Button>
      </div>

      {/* Add New Form */}
      {isAddingNew && (
        <Card className="kit-card border border-indigo-500/30">
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-white mb-2">Title</label>
                <input
                  type="text"
                  placeholder="Enter deliverable title"
                  className="w-full bg-[#181B24] border border-[#2a2f3d] rounded px-3 py-2 text-white placeholder-[#6b7280] focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-white mb-2">Format</label>
                  <select className="w-full bg-[#181B24] border border-[#2a2f3d] rounded px-3 py-2 text-white focus:outline-none focus:border-indigo-500 transition-colors">
                    <option>Video</option>
                    <option>Audio</option>
                    <option>Image</option>
                    <option>Document</option>
                    <option>Animation</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-white mb-2">Due Date</label>
                  <input
                    type="date"
                    className="w-full bg-[#181B24] border border-[#2a2f3d] rounded px-3 py-2 text-white focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="primary">
                  Create Deliverable
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setIsAddingNew(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Deliverables List */}
      <div className="space-y-4">
        {deliverables.map((deliverable) => (
          <Card key={deliverable.id} className="kit-card hover:border-[#3a3f4d] transition-colors">
            <CardContent className="pt-6">
              <div className="space-y-4">
                {/* Title and Status */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-semibold text-white">{deliverable.title}</h3>
                    <div className="flex items-center gap-2 mt-2 text-xs text-[#9ca3af]">
                      <span className="capitalize">{deliverable.format}</span>
                      {deliverable.delivery_url && (
                        <>
                          <span className="text-[#6b7280]">•</span>
                          <a
                            href={deliverable.delivery_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition-colors"
                          >
                            View <ExternalLink className="w-3 h-3" />
                          </a>
                        </>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => handleStatusClick(deliverable.id)}
                    className="flex-shrink-0 transition-transform hover:scale-105"
                  >
                    <Badge
                      variant={
                        statusColors[deliverable.status] as 'default' | 'success' | 'warning' | 'danger' | 'info'
                      }
                      size="md"
                    >
                      {statusLabels[deliverable.status]}
                    </Badge>
                  </button>
                </div>

                {/* Specs */}
                <div className="bg-[#181B24] rounded-lg p-3">
                  <p className="text-xs font-semibold text-[#9ca3af] mb-2 uppercase">Specifications</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {Object.entries(deliverable.specs).map(([key, value]) => (
                      <div key={key}>
                        <p className="text-xs text-[#6b7280] capitalize">
                          {key.replace('_', ' ')}
                        </p>
                        <p className="text-sm text-white font-mono">{value}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2 pt-2 border-t border-[#2a2f3d]">
                  <Button size="sm" variant="ghost">
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost">
                    Download
                  </Button>
                  {deliverable.status !== 'delivered' && (
                    <Button size="sm" variant="ghost">
                      Mark as Delivered
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Drag & Drop Info */}
      <Card className="kit-card border border-[#2a2f3d]">
        <CardContent className="pt-6 flex gap-3 items-start">
          <GripVertical className="w-5 h-5 text-[#6b7280] flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-[#9ca3af]">
              Drag deliverables to reorder them. Click status badges to cycle through stages.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
