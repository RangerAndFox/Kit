// @ts-nocheck
/**
 * One-shot staff directory sync.
 *
 * Pulls active Slack workspace users + active Harvest users, matches by
 * email, upserts into public.staff. Leaves `role` NULL unless preserved
 * from an existing row — assign roles manually in Supabase Studio after.
 *
 * Run from the bolt/ directory:
 *   npx tsx scripts/sync-staff.ts
 *
 * Required env (loaded via dotenv):
 *   SLACK_BOT_TOKEN
 *   HARVEST_ACCESS_TOKEN, HARVEST_ACCOUNT_ID
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config'
import { listUsers as listHarvestUsers } from '../../src/lib/harvest/client'
import { createAdminClient } from '../../src/lib/supabase/admin'

interface SlackUser {
  id: string
  email: string | null
  fullName: string | null
}

async function listSlackUsers(): Promise<SlackUser[]> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('SLACK_BOT_TOKEN required')

  const out: SlackUser[] = []
  let cursor: string | undefined
  do {
    const url = new URL('https://slack.com/api/users.list')
    url.searchParams.set('limit', '200')
    if (cursor) url.searchParams.set('cursor', cursor)
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
    const data = await r.json()
    if (!data.ok) throw new Error(`Slack users.list failed: ${data.error}`)

    for (const m of data.members || []) {
      if (m.is_bot || m.deleted || m.id === 'USLACKBOT') continue
      const email = m.profile?.email || null
      const fullName =
        m.profile?.real_name ||
        m.profile?.real_name_normalized ||
        m.profile?.display_name ||
        m.name ||
        null
      out.push({ id: m.id, email, fullName })
    }
    cursor = data.response_metadata?.next_cursor || undefined
  } while (cursor)
  return out
}

async function main() {
  console.log('[sync-staff] Fetching Slack users...')
  const slackUsers = await listSlackUsers()
  console.log(`[sync-staff] ${slackUsers.length} active Slack users`)

  console.log('[sync-staff] Fetching Harvest users...')
  const harvestUsers = await listHarvestUsers()
  console.log(`[sync-staff] ${harvestUsers.length} active Harvest users`)

  // Index Harvest by lowercased email for matching.
  const harvestByEmail = new Map<string, (typeof harvestUsers)[number]>()
  for (const h of harvestUsers) {
    if (h.email) harvestByEmail.set(h.email.toLowerCase(), h)
  }

  const sb = createAdminClient()
  let matched = 0
  let unmatched = 0
  let upserted = 0

  for (const u of slackUsers) {
    if (!u.email) {
      unmatched++
      continue
    }
    const h = harvestByEmail.get(u.email.toLowerCase())
    if (h) matched++
    else unmatched++

    // Upsert by slack_user_id. Preserve existing role; sync everything else.
    const { error } = await sb.from('staff').upsert(
      {
        slack_user_id: u.id,
        email: u.email,
        full_name: u.fullName,
        harvest_user_id: h ? h.id : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'slack_user_id' },
    )
    if (error) {
      console.warn(`[sync-staff] upsert failed for ${u.id} (${u.email}): ${error.message}`)
      continue
    }
    upserted++
  }

  console.log(
    `[sync-staff] Done — upserted ${upserted}, matched-to-Harvest ${matched}, unmatched ${unmatched}`,
  )
  console.log('[sync-staff] Next step: open Supabase Studio and set role=creative on the right people.')
}

main().catch((err) => {
  console.error('[sync-staff] FAILED:', err)
  process.exit(1)
})
