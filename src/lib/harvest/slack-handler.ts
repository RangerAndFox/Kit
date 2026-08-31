/**
 * Harvest ↔ Slack Time Entry Handler
 *
 * Flow:
 * 1. Artist posts "spent 3 hours on NRG today"
 * 2. Kit parses the time entry
 * 3. Kit tries to match "NRG" to a Kit project with a linked Harvest project
 * 4. If no match or ambiguous → Kit replies asking which project
 * 5. Once confirmed → Kit logs the time in Harvest and confirms
 */

import { parseTimeEntry, resolveDate, type ParsedTimeEntry } from './time-parser'
import {
  searchProjects,
  getDefaultTask,
  createTimeEntry,
  listProjectTasks,
  type HarvestProject,
} from './client'
import { createAdminClient } from '@/lib/supabase/admin'

const SLACK_API = 'https://slack.com/api'

function slackHeaders() {
  return {
    Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    'Content-Type': 'application/json; charset=utf-8',
  }
}

/**
 * Check if a message looks like a casual time entry.
 */
export function isTimeEntryMessage(text: string): boolean {
  return parseTimeEntry(text) !== null
}

/**
 * Handle a detected time entry message from Slack.
 */
export async function handleTimeEntry(opts: {
  text: string
  channelId: string
  threadTs: string
  messageTs: string
  userId: string
  workspaceId: string
}): Promise<void> {
  const { text, channelId, threadTs, messageTs, userId, workspaceId } = opts

  const parsed = parseTimeEntry(text)
  if (!parsed) return

  console.log('[Harvest] Parsed time entry:', parsed)

  try {
    // Try to resolve the project
    const project = await resolveProject(parsed.projectHint, workspaceId)

    if (!project) {
      // Couldn't find a project — ask the user
      await askForProject(channelId, threadTs, parsed, userId)
      return
    }

    if (project.ambiguous) {
      // Multiple matches — ask the user to pick
      await askToPickProject(channelId, threadTs, parsed, project.matches ?? [], userId)
      return
    }

    // We have a clear match — log the time
    await logTimeAndConfirm({
      channelId,
      threadTs,
      parsed,
      harvestProjectId: project.harvestProjectId,
      harvestProjectName: project.harvestProjectName,
      userId,
      workspaceId,
    })
  } catch (err: any) {
    console.error('[Harvest] Time entry failed:', err)
    await postMessage(
      channelId,
      threadTs,
      `:warning: Couldn't log time to Harvest: ${err.message}`
    )
  }
}

// ─── Project Resolution ─────────────────────────────────────

interface ProjectMatch {
  kitProjectId?: string
  harvestProjectId: number
  harvestProjectName: string
}

interface ResolveResult {
  harvestProjectId: number
  harvestProjectName: string
  ambiguous?: boolean
  matches?: ProjectMatch[]
}

/**
 * Try to match a project hint to a Harvest project.
 * First checks Kit's Supabase projects (which may have harvest_project_id),
 * then falls back to searching Harvest directly.
 */
async function resolveProject(
  hint: string | null,
  workspaceId: string
): Promise<ResolveResult | null> {
  if (!hint || hint.length < 2) return null

  const db = createAdminClient()

  // Step 1: Check Kit projects with linked Harvest IDs
  const { data: kitProjects } = await db
.from('projects')
    .select('id, name, client, project_code, harvest_project_id')
    .eq('workspace_id', workspaceId)
    .not('harvest_project_id', 'is', null)

  if (kitProjects && kitProjects.length > 0) {
    const q = hint.toLowerCase()
    const kitMatches = kitProjects.filter(
      (p: any) =>
        p.name?.toLowerCase().includes(q) ||
        p.client?.toLowerCase().includes(q) ||
        p.project_code?.toLowerCase().includes(q)
    )

    if (kitMatches.length === 1) {
      const match = kitMatches[0]
      if (!match || match.harvest_project_id == null) return null
      return {
        harvestProjectId: match.harvest_project_id,
        harvestProjectName: match.name,
      }
    }

    if (kitMatches.length > 1) {
      return {
        harvestProjectId: 0,
        harvestProjectName: '',
        ambiguous: true,
        matches: kitMatches.map((p: any) => ({
          kitProjectId: p.id,
          harvestProjectId: p.harvest_project_id,
          harvestProjectName: p.name,
        })),
      }
    }
  }

  // Step 2: Search Harvest directly
  const harvestMatches = await searchProjects(hint)

  if (harvestMatches.length === 0) return null
  if (harvestMatches.length === 1) {
    return {
      harvestProjectId: harvestMatches[0].id,
      harvestProjectName: harvestMatches[0].name,
    }
  }

  // Multiple matches
  return {
    harvestProjectId: 0,
    harvestProjectName: '',
    ambiguous: true,
    matches: harvestMatches.slice(0, 5).map((p) => ({
      harvestProjectId: p.id,
      harvestProjectName: p.name,
    })),
  }
}

// ─── Time Logging ───────────────────────────────────────────

async function logTimeAndConfirm(opts: {
  channelId: string
  threadTs: string
  parsed: ParsedTimeEntry
  harvestProjectId: number
  harvestProjectName: string
  userId: string
  workspaceId: string
}): Promise<void> {
  const { channelId, threadTs, parsed, harvestProjectId, harvestProjectName, userId, workspaceId } = opts

  // Get the default task for this project
  const task = await getDefaultTask(harvestProjectId)
  if (!task) {
    await postMessage(
      channelId,
      threadTs,
      `:warning: Found project *${harvestProjectName}* in Harvest but it has no active tasks. Add a task in Harvest first.`
    )
    return
  }

  // Resolve the Harvest user ID for this Slack user
  const harvestUserId = await resolveHarvestUser(userId, workspaceId)

  // Create the time entry
  const spentDate = resolveDate(parsed.date)
  const entry = await createTimeEntry({
    projectId: harvestProjectId,
    taskId: task.id,
    hours: parsed.hours,
    spentDate,
    notes: parsed.notes || undefined,
    userId: harvestUserId || undefined,
  })

  // Confirm in Slack
  const hoursText = parsed.hours === 1 ? '1 hour' : `${parsed.hours} hours`
  await postMessage(
    channelId,
    threadTs,
    `:white_check_mark: Logged *${hoursText}* to *${harvestProjectName}* (${task.name}) for ${spentDate}` +
      (entry.notes ? `\n_"${entry.notes}"_` : '')
  )
}

// ─── Conversational Prompts ─────────────────────────────────

async function askForProject(
  channelId: string,
  threadTs: string,
  parsed: ParsedTimeEntry,
  userId: string
): Promise<void> {
  const hoursText = parsed.hours === 1 ? '1 hour' : `${parsed.hours} hours`
  const hint = parsed.projectHint ? ` for "${parsed.projectHint}"` : ''

  await postMessage(
    channelId,
    threadTs,
    `:clock3: Got it — *${hoursText}*${hint}. Which project should I log this to?\n` +
      `Just reply with the project name and I'll find it in Harvest.`
  )
}

async function askToPickProject(
  channelId: string,
  threadTs: string,
  parsed: ParsedTimeEntry,
  matches: ProjectMatch[],
  userId: string
): Promise<void> {
  const hoursText = parsed.hours === 1 ? '1 hour' : `${parsed.hours} hours`
  const options = matches
    .map((m, i) => `*${i + 1}.* ${m.harvestProjectName}`)
    .join('\n')

  await postMessage(
    channelId,
    threadTs,
    `:clock3: Logging *${hoursText}* — I found a few matching projects:\n${options}\n\nReply with the number or project name.`
  )
}

// ─── User Resolution ────────────────────────────────────────

/**
 * Look up the Harvest user ID for a Slack user.
 * Returns null if no mapping exists (time entry will be logged under the token owner).
 */
async function resolveHarvestUser(
  slackUserId: string,
  workspaceId: string
): Promise<number | null> {
  try {
    const db = createAdminClient()
    const { data } = await db
.from('harvest_user_map')
      .select('harvest_user_id')
      .eq('workspace_id', workspaceId)
      .eq('slack_user_id', slackUserId)
      .maybeSingle()

    return data?.harvest_user_id || null
  } catch {
    return null
  }
}

// ─── Slack Helpers ──────────────────────────────────────────

async function postMessage(
  channel: string,
  threadTs: string,
  text: string
): Promise<any> {
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: slackHeaders(),
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  })
  const data = await res.json()
  if (!data.ok) console.error('[Slack] postMessage failed:', data.error)
  return data
}
