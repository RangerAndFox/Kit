/**
 * One-off remediation for two over-logged recovery commits (Allyson, 7/31 &
 * 8/10). The recovery script's wide reply window over-captured her other
 * replies and the LLM duplicated on top, so --commit wrote 9 and 7 Harvest
 * entries where there should have been 2 and 4.
 *
 * This is fully DETERMINISTIC — no LLM, no parsing, no history window. It:
 *   1. Deletes the 16 wrongly-created Harvest time entries (by exact id).
 *   2. Re-creates her actual entries, taken verbatim from her own clean
 *      replies ("2 hours #2631, 6 hours misc" / "2h 2637, 2h 2631, 1h 2636,
 *      3h Misc"), with the correct spent_date.
 *   3. Repoints the two daily_hours_checkins rows at the new entry ids.
 *
 * Run from bolt/ (needs the same .env as the recovery script + Harvest creds):
 *   npx tsx scripts/fix-overlogged-checkins.ts            # DRY RUN (no changes)
 *   npx tsx scripts/fix-overlogged-checkins.ts --commit   # delete + re-create
 */

import 'dotenv/config'
import { createAdminClient } from '../../src/lib/supabase/admin'
import { createTimeEntry, getDefaultTask } from '../../src/lib/harvest/client'

const COMMIT = process.argv.includes('--commit')

// The exact entries --commit wrongly created (9 for 7/31, 7 for 8/10).
const BAD_ENTRY_IDS = [
  2988094491, 2988094493, 2988094494, 2988094495, 2988094497, 2988094500,
  2988094502, 2988094503, 2988094505, // 2026-07-31
  2988094515, 2988094517, 2988094519, 2988094521, 2988094522, 2988094523,
  2988094525, // 2026-08-10
]

const ALLYSON_HARVEST_USER_ID = 5665959

// Her real entries, verbatim from her own replies. projectIds are the ones the
// resolver already matched (visible in the logged parsed_entries).
const FIXES = [
  {
    checkinId: '6ce7ce5a-a765-4ab5-99cc-6aeca7c8b4ee',
    date: '2026-07-31', // "2 hours #2631, 6 hours misc"
    entries: [
      { hours: 2, projectId: 48797463, name: 'Power vNext Launch' },
      { hours: 6, projectId: 48641580, name: 'Miscellaneous' },
    ],
  },
  {
    checkinId: '18df2b9d-5939-403b-84d4-2dfac3b86fad',
    date: '2026-08-10', // "2h on 2637, 2h on 2631, 1h on 2636, 3h on Misc"
    entries: [
      { hours: 2, projectId: 48917221, name: 'Microsoft Fabric IQ sizzle video' },
      { hours: 2, projectId: 48797463, name: 'Power vNext Launch' },
      { hours: 1, projectId: 48917210, name: 'FY27 Q1 – D365 Contact Center Sizzle' },
      { hours: 3, projectId: 48641580, name: 'Miscellaneous' },
    ],
  },
]

function harvestHeaders() {
  const token = process.env.HARVEST_ACCESS_TOKEN
  const accountId = process.env.HARVEST_ACCOUNT_ID
  if (!token || !accountId) throw new Error('HARVEST_ACCESS_TOKEN + HARVEST_ACCOUNT_ID required')
  return {
    Authorization: `Bearer ${token}`,
    'Harvest-Account-Id': accountId,
    'User-Agent': 'Kit Remediation (kit@rangerandfox.tv)',
    'Content-Type': 'application/json',
  }
}

async function deleteEntry(id: number): Promise<'deleted' | 'already-gone'> {
  const res = await fetch(`https://api.harvestapp.com/v2/time_entries/${id}`, {
    method: 'DELETE',
    headers: harvestHeaders(),
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status === 200 || res.status === 204) return 'deleted'
  if (res.status === 404) return 'already-gone'
  throw new Error(`delete ${id}: ${res.status} ${await res.text().catch(() => '')}`)
}

async function main() {
  const sb = createAdminClient()
  console.log(`${COMMIT ? 'REMEDIATE (writing)' : 'DRY RUN (no changes)'}\n`)

  // ── 1. Delete the 16 bad entries ────────────────────────────
  console.log(`Delete ${BAD_ENTRY_IDS.length} over-logged Harvest entries:`)
  for (const id of BAD_ENTRY_IDS) {
    if (!COMMIT) {
      console.log(`  would delete #${id}`)
      continue
    }
    try {
      const r = await deleteEntry(id)
      console.log(`  #${id}: ${r}`)
    } catch (err: any) {
      console.log(`  #${id}: ERROR ${err.message}`)
    }
  }

  // ── 2. Re-create the correct entries + 3. repoint the rows ──
  for (const fix of FIXES) {
    console.log(`\n${fix.date} — re-create ${fix.entries.length} correct entr(ies):`)
    const newIds: number[] = []
    for (const e of fix.entries) {
      if (!COMMIT) {
        console.log(`  would log ${e.hours}h → ${e.name}`)
        continue
      }
      try {
        const task = await getDefaultTask(e.projectId)
        if (!task) {
          console.log(`  ${e.hours}h ${e.name}: ERROR no default task`)
          continue
        }
        const te = await createTimeEntry({
          projectId: e.projectId,
          taskId: task.id,
          hours: e.hours,
          spentDate: fix.date,
          userId: ALLYSON_HARVEST_USER_ID,
        })
        newIds.push(te.id)
        console.log(`  ${e.hours}h → ${e.name} — Harvest #${te.id}`)
      } catch (err: any) {
        console.log(`  ${e.hours}h ${e.name}: ERROR ${err.message}`)
      }
    }

    if (!COMMIT) continue
    const { error } = await sb
      .from('daily_hours_checkins')
      .update({
        status: 'logged',
        harvest_entry_ids: newIds,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', fix.checkinId)
    console.log(
      error
        ? `  row ${fix.checkinId}: DB update ERROR ${error.message}`
        : `  row ${fix.checkinId}: harvest_entry_ids → [${newIds.join(', ')}]`,
    )
  }

  console.log(`\n${COMMIT ? 'Done.' : 'Dry run only — re-run with --commit to apply.'}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
