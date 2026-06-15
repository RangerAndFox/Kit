// @ts-nocheck
/**
 * Read-only audit: find Kit-created project channels that have no matching
 * `projects` row (the "orphaned project" state — e.g. #2625-azure-gov).
 *
 * Lists every Slack channel (public + private, including archived), filters to
 * ones whose name looks like a project channel (`<code>-<client>`), and reports
 * any whose channel id isn't linked from a projects row. Also reports the
 * reverse: projects rows whose linked channel no longer exists.
 *
 * Run with: npx tsx scripts/audit-orphaned-project-channels.ts
 *
 * Requires env: SLACK_BOT_TOKEN, NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL),
 *   SUPABASE_SERVICE_ROLE_KEY.
 *
 * Read-only — makes no changes. Safe to run anytime.
 */

import { createAdminClient } from '../src/lib/supabase/admin'

// Project channels are named "<code>-<client>", e.g. 2625-azure-gov, 3000-nike.
const PROJECT_CHANNEL_RE = /^\d{3,5}[a-z]?-/i

interface SlackChannel {
  id: string
  name: string
  is_archived: boolean
  created: number
  creator?: string
}

async function slackApi(method: string, params: Record<string, string>): Promise<any> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('SLACK_BOT_TOKEN required')
  const url = `https://slack.com/api/${method}?${new URLSearchParams(params)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error}`)
  return json
}

async function listAllChannels(): Promise<SlackChannel[]> {
  const out: SlackChannel[] = []
  let cursor = ''
  do {
    const data = await slackApi('conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: 'false',
      limit: '200',
      ...(cursor ? { cursor } : {}),
    })
    for (const c of data.channels || []) {
      out.push({
        id: c.id,
        name: c.name,
        is_archived: !!c.is_archived,
        created: c.created,
        creator: c.creator,
      })
    }
    cursor = data.response_metadata?.next_cursor || ''
  } while (cursor)
  return out
}

async function main() {
  const sb = createAdminClient()
  const { data: projects, error } = await sb
    .from('projects')
    .select('id, name, project_code, external_links')
  if (error) throw new Error(`projects query failed: ${error.message}`)

  // Every channel id referenced by a projects row.
  const linkedChannelIds = new Set<string>()
  const channelToProject = new Map<string, any>()
  for (const p of projects || []) {
    const links = p.external_links || {}
    for (const key of ['slack_id', 'slack_channel_id']) {
      const id = links[key]
      if (id) {
        linkedChannelIds.add(id)
        channelToProject.set(id, p)
      }
    }
  }

  const channels = await listAllChannels()
  const projectChannels = channels.filter((c) => PROJECT_CHANNEL_RE.test(c.name))

  // Orphans: project-shaped channels with no projects row pointing at them.
  const orphans = projectChannels.filter((c) => !linkedChannelIds.has(c.id))

  // Reverse: projects rows whose linked channel no longer exists in Slack.
  const existingChannelIds = new Set(channels.map((c) => c.id))
  const danglingRows = [...channelToProject.entries()].filter(
    ([id]) => !existingChannelIds.has(id),
  )

  console.log(`\nScanned ${channels.length} channels, ${projectChannels.length} look like project channels.`)
  console.log(`Loaded ${projects?.length || 0} projects rows.\n`)

  console.log(`── Orphaned channels (channel exists, no projects row): ${orphans.length} ──`)
  for (const c of orphans.sort((a, b) => a.created - b.created)) {
    const when = new Date(c.created * 1000).toISOString().slice(0, 10)
    console.log(`  #${c.name}  (${c.id})  created ${when}${c.is_archived ? '  [archived]' : ''}`)
  }

  console.log(`\n── Dangling project rows (row links a channel that no longer exists): ${danglingRows.length} ──`)
  for (const [id, p] of danglingRows) {
    console.log(`  ${p.project_code || p.name}  →  missing channel ${id}  (project ${p.id})`)
  }
  console.log('')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
