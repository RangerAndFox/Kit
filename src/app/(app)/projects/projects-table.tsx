'use client'

import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import { ChevronRight, Search } from 'lucide-react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'

interface Project {
  id: string
  name: string
  client_name: string
  code: string
  status: string
  budget: number
  spent: number
  due_date: string | null
  health: 'emerald' | 'amber' | 'coral'
}

interface ProjectsTableProps {
  projects: Project[]
}

const statusOptions = [
  { value: 'all', label: 'All' },
  { value: 'planning', label: 'Planning' },
  { value: 'in_progress', label: 'Active' },
  { value: 'in_review', label: 'In Review' },
  { value: 'completed', label: 'Wrapped' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'archived', label: 'Archived' },
]

const statusLabels: Record<string, string> = {
  active: 'Active',
  draft: 'Draft',
  wrapped: 'Wrapped',
  planning: 'Planning',
  in_progress: 'In Progress',
  in_review: 'In Review',
  completed: 'Wrapped',
  on_hold: 'On Hold',
  archived: 'Archived',
}

const healthColors = {
  emerald: { bg: 'bg-emerald-500/20', text: 'text-emerald-300', border: 'border-emerald-500/30' },
  amber: { bg: 'bg-amber-500/20', text: 'text-amber-300', border: 'border-amber-500/30' },
  coral: { bg: 'bg-red-500/20', text: 'text-red-300', border: 'border-red-500/30' },
}

export function ProjectsTable({ projects }: ProjectsTableProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  const filteredProjects = useMemo(() => {
    return projects.filter((project) => {
      const matchesSearch =
        project.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        project.client_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        project.code.toLowerCase().includes(searchQuery.toLowerCase())

      const matchesStatus = statusFilter === 'all' || project.status === statusFilter

      return matchesSearch && matchesStatus
    })
  }, [projects, searchQuery, statusFilter])

  const formatDate = (value: string | null) => {
    if (!value) return '—'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '—'
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    }).format(date)
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(amount)
  }

  const getBudgetPercentage = (spent: number, budget: number) => {
    if (budget === 0) return 0
    return Math.round((spent / budget) * 100)
  }

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.03,
        delayChildren: 0.1,
      },
    },
  }

  const itemVariants = {
    hidden: { opacity: 0, y: 10 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.3, ease: 'easeOut' as const },
    },
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search
            size={18}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6b7280]"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by project, client, or code..."
            className="w-full pl-10 pr-4 py-2 rounded border bg-[#0C0E12] border-[#2a2f3d] text-white placeholder-[#6b7280] transition-colors duration-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        {/* Status Filter */}
        <div className="flex gap-2 overflow-x-auto pb-2 md:pb-0">
          {statusOptions.map((status) => (
            <button
              key={status.value}
              onClick={() => setStatusFilter(status.value)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                statusFilter === status.value
                  ? 'bg-indigo-600 text-white'
                  : 'bg-[#181B24] text-[#b4b8c3] border border-[#2a2f3d] hover:border-[#3a3f4d]'
              }`}
            >
              {status.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table / List */}
      {filteredProjects.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="kit-card py-16 px-8 text-center space-y-4"
        >
          <div className="space-y-2">
            <h3 className="text-xl font-semibold text-white">No projects found</h3>
            <p className="text-[#b4b8c3]">
              {searchQuery || statusFilter !== 'all'
                ? 'Try adjusting your filters'
                : 'Get started by creating your first project'}
            </p>
          </div>
        </motion.div>
      ) : (
        <>
          {/* Desktop Table */}
          <div className="hidden lg:block overflow-x-auto rounded-lg border border-[#2a2f3d]">
            <motion.table
              variants={containerVariants}
              initial="hidden"
              animate="visible"
              className="w-full text-sm text-white"
            >
              <thead className="bg-[#0C0E12] border-b border-[#2a2f3d]">
                <tr>
                  <th className="px-6 py-3 text-left font-semibold text-[#b4b8c3]">
                    Project
                  </th>
                  <th className="px-6 py-3 text-left font-semibold text-[#b4b8c3]">Client</th>
                  <th className="px-6 py-3 text-left font-semibold text-[#b4b8c3]">Code</th>
                  <th className="px-6 py-3 text-left font-semibold text-[#b4b8c3]">Status</th>
                  <th className="px-6 py-3 text-left font-semibold text-[#b4b8c3]">Budget</th>
                  <th className="px-6 py-3 text-left font-semibold text-[#b4b8c3]">Due Date</th>
                  <th className="px-6 py-3 text-left font-semibold text-[#b4b8c3]">Health</th>
                  <th className="px-6 py-3 text-right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2a2f3d] bg-[#181B24]">
                {filteredProjects.map((project) => (
                  <motion.tr
                    key={project.id}
                    variants={itemVariants}
                    className="hover:bg-[#1f2332] transition-colors cursor-pointer group"
                  >
                    <td className="px-6 py-4">
                      <Link href={`/control-center/projects/${project.id}`} className="block">
                        <p className="font-medium text-white group-hover:text-indigo-400 transition-colors">
                          {project.name}
                        </p>
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-[#b4b8c3]">
                      <Link href={`/control-center/projects/${project.id}`}>{project.client_name}</Link>
                    </td>
                    <td className="px-6 py-4">
                      <Link href={`/control-center/projects/${project.id}`}>
                        <code className="px-2 py-1 rounded bg-[#0C0E12] text-[#6366F1] font-mono text-xs">
                          {project.code}
                        </code>
                      </Link>
                    </td>
                    <td className="px-6 py-4">
                      <Link href={`/control-center/projects/${project.id}`}>
                        <Badge
                          variant="info"
                          size="sm"
                          className="capitalize"
                        >
                          {statusLabels[project.status] || project.status.replaceAll('_', ' ')}
                        </Badge>
                      </Link>
                    </td>
                    <td className="px-6 py-4">
                      <Link href={`/control-center/projects/${project.id}`}>
                        <div className="space-y-1">
                          <div className="w-24 h-2 bg-[#0C0E12] rounded-full overflow-hidden">
                            <motion.div
                              initial={{ width: 0 }}
                              animate={{
                                width: `${Math.min(getBudgetPercentage(project.spent, project.budget), 100)}%`,
                              }}
                              transition={{ duration: 0.6, ease: 'easeOut' }}
                              className="h-full rounded-full bg-indigo-600"
                            />
                          </div>
                          <span className="text-xs text-[#6b7280] font-mono">
                            {getBudgetPercentage(project.spent, project.budget)}%
                          </span>
                        </div>
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-[#b4b8c3]">
                      <Link href={`/control-center/projects/${project.id}`}>
                        {formatDate(project.due_date)}
                      </Link>
                    </td>
                    <td className="px-6 py-4">
                      <Link href={`/control-center/projects/${project.id}`}>
                        <div
                          className="w-3 h-3 rounded-full"
                          style={{
                            backgroundColor:
                              project.health === 'emerald'
                                ? '#10B981'
                                : project.health === 'amber'
                                  ? '#F59E0B'
                                  : '#EF4444',
                          }}
                        />
                      </Link>
                    </td>
                    <td className="px-6 py-4">
                      <Link href={`/control-center/projects/${project.id}`}>
                        <ChevronRight
                          size={16}
                          className="text-[#6b7280] group-hover:translate-x-1 transition-transform"
                        />
                      </Link>
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </motion.table>
          </div>

          {/* Mobile Cards */}
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="lg:hidden space-y-3"
          >
            {filteredProjects.map((project) => (
              <motion.div key={project.id} variants={itemVariants}>
                <Link href={`/control-center/projects/${project.id}`}>
                  <div className="kit-card-interactive space-y-3">
                    {/* Header */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <h3 className="font-semibold text-white">{project.name}</h3>
                        <p className="text-sm text-[#b4b8c3]">{project.client_name}</p>
                      </div>
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{
                          backgroundColor:
                            project.health === 'emerald'
                              ? '#10B981'
                              : project.health === 'amber'
                                ? '#F59E0B'
                                : '#EF4444',
                        }}
                      />
                    </div>

                    {/* Code & Status */}
                    <div className="flex items-center justify-between">
                      <code className="px-2 py-1 rounded bg-[#0C0E12] text-[#6366F1] font-mono text-xs">
                        {project.code}
                      </code>
                      <Badge variant="info" size="sm" className="capitalize">
                        {statusLabels[project.status] || project.status.replaceAll('_', ' ')}
                      </Badge>
                    </div>

                    {/* Budget */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-[#6b7280]">Budget</span>
                        <span className="text-xs font-mono text-[#b4b8c3]">
                          {getBudgetPercentage(project.spent, project.budget)}%
                        </span>
                      </div>
                      <div className="w-full h-2 bg-[#0C0E12] rounded-full overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{
                            width: `${Math.min(getBudgetPercentage(project.spent, project.budget), 100)}%`,
                          }}
                          transition={{ duration: 0.6, ease: 'easeOut' }}
                          className="h-full rounded-full bg-indigo-600"
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-[#6b7280]">
                          {formatCurrency(project.spent)} of {formatCurrency(project.budget)}
                        </span>
                      </div>
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between pt-2 border-t border-[#2a2f3d]">
                      <span className="text-xs text-[#6b7280]">{formatDate(project.due_date)}</span>
                      <ChevronRight size={16} className="text-[#6b7280]" />
                    </div>
                  </div>
                </Link>
              </motion.div>
            ))}
          </motion.div>
        </>
      )}

      {/* Count Footer */}
      {filteredProjects.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-xs text-[#6b7280] text-center py-4"
        >
          Showing {filteredProjects.length} of {projects.length} projects
        </motion.div>
      )}
    </div>
  )
}
