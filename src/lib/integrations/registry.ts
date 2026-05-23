/**
 * Integration service registry
 * Defines all available integrations and their metadata
 */

/**
 * Integration service definition
 */
export interface IntegrationService {
  id: string
  name: string
  category: IntegrationCategory
  description: string
  icon: string // Lucide icon name
  status: 'available' | 'coming_soon' | 'beta'
  requiresOAuth: boolean
  documentationUrl?: string
}

export type IntegrationCategory =
  | 'time_tracking'
  | 'project_management'
  | 'communication'
  | 'creative'
  | 'transcription'
  | 'video'
  | 'finance'
  | 'calendar'
  | 'storage'
  | 'other'

/**
 * Complete registry of 25 integration services
 */
export const INTEGRATION_REGISTRY: IntegrationService[] = [
  // Time Tracking (3)
  {
    id: 'clockify',
    name: 'Clockify',
    category: 'time_tracking',
    description: 'Time tracking and timesheet management',
    icon: 'Clock',
    status: 'available',
    requiresOAuth: false,
  },
  {
    id: 'harvest',
    name: 'Harvest',
    category: 'time_tracking',
    description: 'Time tracking and invoice management',
    icon: 'Clock',
    status: 'available',
    requiresOAuth: true,
  },
  {
    id: 'toggl',
    name: 'Toggl',
    category: 'time_tracking',
    description: 'Time tracking and reporting',
    icon: 'Clock',
    status: 'coming_soon',
    requiresOAuth: true,
  },

  // Project Management (4)
  {
    id: 'monday',
    name: 'Monday.com',
    category: 'project_management',
    description: 'Project management and team collaboration',
    icon: 'Zap',
    status: 'beta',
    requiresOAuth: true,
  },
  {
    id: 'asana',
    name: 'Asana',
    category: 'project_management',
    description: 'Task and project management platform',
    icon: 'CheckSquare',
    status: 'available',
    requiresOAuth: true,
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'project_management',
    description: 'Notes, databases, and workspace management',
    icon: 'BookOpen',
    status: 'coming_soon',
    requiresOAuth: true,
  },
  {
    id: 'clickup',
    name: 'ClickUp',
    category: 'project_management',
    description: 'All-in-one project management platform',
    icon: 'ListChecks',
    status: 'beta',
    requiresOAuth: true,
  },

  // Communication (3)
  {
    id: 'slack',
    name: 'Slack',
    category: 'communication',
    description: 'Team messaging and collaboration',
    icon: 'MessageCircle',
    status: 'available',
    requiresOAuth: true,
  },
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'communication',
    description: 'Email management and sync',
    icon: 'Mail',
    status: 'coming_soon',
    requiresOAuth: true,
  },
  {
    id: 'outlook',
    name: 'Outlook',
    category: 'communication',
    description: 'Email and calendar management',
    icon: 'Mail',
    status: 'coming_soon',
    requiresOAuth: true,
  },

  // Creative Tools (3)
  {
    id: 'frameio',
    name: 'Frame.io',
    category: 'creative',
    description: 'Video collaboration and review platform',
    icon: 'Film',
    status: 'available',
    requiresOAuth: true,
  },
  {
    id: 'figma',
    name: 'Figma',
    category: 'creative',
    description: 'Design and prototyping platform',
    icon: 'Layers',
    status: 'available',
    requiresOAuth: true,
  },
  {
    id: 'adobe_cc',
    name: 'Adobe Creative Cloud',
    category: 'creative',
    description: 'Creative suite asset integration',
    icon: 'Palette',
    status: 'coming_soon',
    requiresOAuth: true,
  },

  // Transcription (3)
  {
    id: 'otter',
    name: 'Otter.ai',
    category: 'transcription',
    description: 'AI-powered transcription and notes',
    icon: 'Mic',
    status: 'coming_soon',
    requiresOAuth: true,
  },
  {
    id: 'plaud',
    name: 'Plaud',
    category: 'transcription',
    description: 'Hardware AI recorder — meeting transcripts via webhook',
    icon: 'Mic',
    status: 'beta',
    requiresOAuth: true,
    documentationUrl: 'https://docs.plaud.ai/',
  },
  {
    id: 'fireflies',
    name: 'Fireflies.ai',
    category: 'transcription',
    description: 'Meeting recording and transcription',
    icon: 'Mic',
    status: 'beta',
    requiresOAuth: true,
  },

  // Video (2)
  {
    id: 'vimeo',
    name: 'Vimeo',
    category: 'video',
    description: 'Video hosting and streaming',
    icon: 'Video',
    status: 'available',
    requiresOAuth: true,
  },
  {
    id: 'youtube',
    name: 'YouTube',
    category: 'video',
    description: 'Video publishing and management',
    icon: 'Video',
    status: 'coming_soon',
    requiresOAuth: true,
  },

  // Finance (3)
  {
    id: 'quickbooks',
    name: 'QuickBooks',
    category: 'finance',
    description: 'Accounting and financial management',
    icon: 'DollarSign',
    status: 'coming_soon',
    requiresOAuth: true,
  },
  {
    id: 'bill',
    name: 'Bill.com',
    category: 'finance',
    description: 'Invoice and expense management',
    icon: 'CreditCard',
    status: 'coming_soon',
    requiresOAuth: true,
  },
  {
    id: 'xero',
    name: 'Xero',
    category: 'finance',
    description: 'Accounting and tax software',
    icon: 'BarChart',
    status: 'coming_soon',
    requiresOAuth: true,
  },

  // Calendar (2)
  {
    id: 'google_calendar',
    name: 'Google Calendar',
    category: 'calendar',
    description: 'Calendar sync and meeting management',
    icon: 'Calendar',
    status: 'available',
    requiresOAuth: true,
    documentationUrl: 'https://developers.google.com/calendar/api',
  },
  {
    id: 'outlook_calendar',
    name: 'Outlook Calendar',
    category: 'calendar',
    description: 'Outlook calendar and scheduling',
    icon: 'Calendar',
    status: 'coming_soon',
    requiresOAuth: true,
  },

  // Storage (3)
  {
    id: 'google_drive',
    name: 'Google Drive',
    category: 'storage',
    description: 'Cloud file storage and sync',
    icon: 'Cloud',
    status: 'available',
    requiresOAuth: true,
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    category: 'storage',
    description: 'Cloud file sync and backup',
    icon: 'Cloud',
    status: 'coming_soon',
    requiresOAuth: true,
  },
  {
    id: 'box',
    name: 'Box',
    category: 'storage',
    description: 'Enterprise file management',
    icon: 'Cloud',
    status: 'coming_soon',
    requiresOAuth: true,
  },

  // Other (3)
  {
    id: 'boords',
    name: 'Boords',
    category: 'other',
    description: 'Storyboarding and shot list planning',
    icon: 'ImagePlus',
    status: 'coming_soon',
    requiresOAuth: true,
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    category: 'other',
    description: 'AI voice generation and synthesis',
    icon: 'Volume2',
    status: 'available',
    requiresOAuth: false,
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    category: 'other',
    description: 'WordPress site and content management',
    icon: 'Globe',
    status: 'coming_soon',
    requiresOAuth: true,
  },
]

/**
 * Gets all integrations for a specific category
 * @param category The integration category
 * @returns Array of integrations in that category
 */
export function getIntegrationsByCategory(
  category: IntegrationCategory
): IntegrationService[] {
  return INTEGRATION_REGISTRY.filter(service => service.category === category)
}

/**
 * Gets a specific integration by ID
 * @param id The integration ID
 * @returns The integration service or undefined if not found
 */
export function getIntegration(
  id: string
): IntegrationService | undefined {
  return INTEGRATION_REGISTRY.find(service => service.id === id)
}

/**
 * Gets all integrations with a specific status
 * @param status The status to filter by
 * @returns Array of integrations with that status
 */
export function getIntegrationsByStatus(
  status: 'available' | 'coming_soon' | 'beta'
): IntegrationService[] {
  return INTEGRATION_REGISTRY.filter(service => service.status === status)
}

/**
 * Gets all OAuth integrations
 * @returns Array of OAuth-enabled integrations
 */
export function getOAuthIntegrations(): IntegrationService[] {
  return INTEGRATION_REGISTRY.filter(service => service.requiresOAuth)
}
