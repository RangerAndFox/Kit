import { projectNumberFromCode, projectNumberKey } from '../../../src/lib/studio-knowledge/project-sync'

export const LIVE_SLACK_PROJECT_PREFIX = 'slack:'

export interface SlackProjectChannel {
  id: string
  name: string
  projectNumber: string
  client: string
  projectName: string
  label: string
}

export interface SlackChannelLike {
  id?: string
  name?: string
  creator?: string
  is_archived?: boolean
  purpose?: { value?: string }
  topic?: { value?: string }
}

export interface PickerProjectRow {
  id: string
  name?: string | null
  client?: string | null
  project_code?: string | null
  slack_channel_id?: string | null
  external_links?: Record<string, unknown> | null
}

export interface ReconciledProjectOption {
  /** A projects.id, or `slack:C…` when the channel must be adopted/re-linked. */
  id: string
  label: string
}

function titleFromSlug(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Turn a live Slack channel into a project candidate.
 *
 * A project channel must start with the studio project number and must either
 * carry Kit's purpose marker or have been created by the current Kit bot. The
 * latter covers the legacy `[kit:undefined]` provisioning bug without treating
 * every number-prefixed Slack channel as Kit-owned.
 */
export function parseSlackProjectChannel(
  channel: SlackChannelLike,
  kitBotUserId?: string,
): SlackProjectChannel | null {
  if (!channel.id || !channel.name || channel.is_archived) return null
  const projectNumber = channel.name.match(/^(\d{3,4}[a-z]?)(?:-|$)/i)?.[1]
  if (!projectNumber) return null

  const purpose = channel.purpose?.value || ''
  const hasKitMarker = /\[kit:[0-9a-f]{8}-[0-9a-f-]{27,}\]/i.test(purpose)
  const createdByKit = !!kitBotUserId && channel.creator === kitBotUserId
  if (!hasKitMarker && !createdByKit) return null

  const topic = (channel.topic?.value || purpose.replace(/\s*\[kit:[^\]]+\]\s*/gi, '')).trim()
  const topicParts = topic.split(/\s+[—–]\s+/, 2)
  const slugParts = channel.name.split('-')
  const client = (topicParts.length === 2 ? topicParts[0] : titleFromSlug(slugParts[1] || '')).trim()
  const projectName = (
    topicParts.length === 2
      ? topicParts[1]
      : titleFromSlug(slugParts.slice(2).filter((part) => part !== 'undefined').join('-'))
  ).trim()
  if (!client || !projectName) return null

  return {
    id: channel.id,
    name: channel.name,
    projectNumber,
    client,
    projectName,
    label: `${projectNumber} — ${client} — ${projectName}`,
  }
}

function linkedSlackId(row: PickerProjectRow): string | null {
  const links = row.external_links || {}
  return String(links.slack_id || links.slack_channel_id || row.slack_channel_id || '') || null
}

function rowLabel(row: PickerProjectRow): string {
  const number = projectNumberFromCode(row.project_code) || projectNumberFromCode(row.name) || ''
  return [number, row.client, row.name].filter(Boolean).join(' — ') || row.name || 'Untitled project'
}

/**
 * Reconcile Kit's editable rows with live Slack project channels.
 *
 * - stale rows whose Slack channel is gone are excluded;
 * - rows with a live linked channel remain normal project-id options;
 * - live channels missing a row (or missing the Slack link) become `slack:`
 *   options so the click handler can safely adopt/re-link them before opening.
 */
export function reconcileProjectPicker(
  rows: PickerProjectRow[],
  liveChannels: SlackProjectChannel[],
): ReconciledProjectOption[] {
  const byId = new Map(liveChannels.map((channel) => [channel.id, channel]))
  const byNumber = new Map<string, SlackProjectChannel[]>()
  for (const channel of liveChannels) {
    const key = projectNumberKey(channel.projectNumber)
    if (!key) continue
    const matches = byNumber.get(key) || []
    matches.push(channel)
    byNumber.set(key, matches)
  }

  const usedChannelIds = new Set<string>()
  const options: ReconciledProjectOption[] = []
  for (const row of rows) {
    const linked = linkedSlackId(row)
    const direct = linked ? byId.get(linked) : undefined
    if (direct) {
      usedChannelIds.add(direct.id)
      options.push({ id: row.id, label: rowLabel(row) })
      continue
    }

    const number = projectNumberKey(row.project_code) || projectNumberKey(row.name)
    const numberMatches = number ? byNumber.get(number) || [] : []
    if (numberMatches.length === 1 && !usedChannelIds.has(numberMatches[0].id)) {
      const channel = numberMatches[0]
      usedChannelIds.add(channel.id)
      options.push({ id: `${LIVE_SLACK_PROJECT_PREFIX}${channel.id}`, label: channel.label })
    }
  }

  for (const channel of liveChannels) {
    if (usedChannelIds.has(channel.id)) continue
    options.push({ id: `${LIVE_SLACK_PROJECT_PREFIX}${channel.id}`, label: channel.label })
  }

  return options.sort((a, b) => b.label.localeCompare(a.label, undefined, { numeric: true }))
}
