export type Signal = 'healthy' | 'warning' | 'danger' | 'neutral'

export interface HealthCheck {
  key: string
  label: string
  ok: boolean
  detail?: string
}

export interface AttentionItem {
  id: string
  title: string
  detail: string
  signal: Exclude<Signal, 'healthy' | 'neutral'>
  href?: string
  timestamp?: string
}

export interface QueueSummary {
  key: string
  label: string
  count: number
  oldestAt: string | null
  signal: Signal
}

export interface WorkerSummary {
  id: string
  label: string
  type: 'Render' | 'Behance'
  status: string
  lastSeenAt: string | null
  currentJob: string | null
  detail: string | null
  signal: Signal
}

export interface ProjectSummary {
  id: string
  code: string
  name: string
  client: string
  status: string
  phase: string | null
  targetDelivery: string | null
  updatedAt: string | null
  signal: Signal
}

export interface UsageMetric {
  key: string
  label: string
  value: number
  suffix?: string
  detail: string
}

export interface ReliabilityDay {
  date: string
  label: string
  successful: number
  failed: number
}

export interface ActivityItem {
  id: string
  title: string
  detail: string
  at: string
  signal: Signal
}

export interface TimeLoggingSummary {
  loggedToday: number
  hoursSevenDays: number
  awaitingConfirmation: number
  needsClarification: number
  failed: number
  stuck: number
}

export interface ControlCenterPayload {
  generatedAt: string
  checkedAt: string
  workspace: { id: string; name: string }
  viewer: { displayName: string; role: string }
  overall: 'operational' | 'attention' | 'incident'
  summary: {
    activeProjects: number
    attentionCount: number
    healthyAutomations: number
    totalAutomations: number
    completedSevenDays: number
  }
  integrations: HealthCheck[]
  automations: HealthCheck[]
  attention: AttentionItem[]
  queues: QueueSummary[]
  workers: WorkerSummary[]
  projects: ProjectSummary[]
  usage: UsageMetric[]
  timeLogging: TimeLoggingSummary
  reliability: ReliabilityDay[]
  recentActivity: ActivityItem[]
  safeguards: {
    plaudEnabled: boolean
    transcriptCountSevenDays: number
    sharedTranscriptLeakCount: number
    serviceRoleServerOnly: boolean
  }
}
