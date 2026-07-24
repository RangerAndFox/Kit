/**
 * Local, non-production smoke harness for the Pilots command path.
 *
 *   npx tsx scripts/pilot-smoke.ts
 *
 * Runs the full `/kit pilot …` path (parser → dispatcher → service →
 * completeness → Canvas interface → store contract) against IN-MEMORY FAKES
 * only. It never connects to Supabase or Slack and creates no external state.
 *
 * SAFETY: this harness refuses to run against any remote/production target. It
 * uses fakes exclusively; a remote target requires an explicit unsafe override
 * AND is hard-blocked for the verified production Supabase ref.
 */

import { runSmoke } from '../src/lib/pilots/smoke'

const PROD_SUPABASE_REF = 'ozsxrcgrezpffnpwlrnq'

function assertLocalOnly(): void {
  const target = process.env.PILOT_SMOKE_TARGET // e.g. a URL/ref if someone tries a remote run
  if (!target) return // default: fakes only — safe
  if (target.includes(PROD_SUPABASE_REF)) {
    console.error(`REFUSING: production Supabase (${PROD_SUPABASE_REF}) is never a valid smoke target.`)
    process.exit(2)
  }
  if (process.env.PILOT_SMOKE_ALLOW_REMOTE !== 'i-understand') {
    console.error(
      'REFUSING: a remote PILOT_SMOKE_TARGET requires PILOT_SMOKE_ALLOW_REMOTE=i-understand.\n' +
        'This harness is designed for fakes only; remote execution is intentionally not implemented.',
    )
    process.exit(2)
  }
  console.error('Remote smoke targets are not implemented — running fakes-only regardless.')
}

async function main(): Promise<void> {
  assertLocalOnly()
  console.log('Kit Pilots — local smoke (fakes only, FIXTURE data)\n')
  const report = await runSmoke()
  for (const s of report.steps) {
    console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name} — ${s.detail}`)
  }
  console.log(`\n${report.passed ? '✅ SMOKE PASSED' : '❌ SMOKE FAILED'} (pilotId=${report.pilotId ?? 'n/a'})`)
  process.exit(report.passed ? 0 : 1)
}

main().catch((err) => {
  console.error('smoke harness error:', err?.message || err)
  process.exit(1)
})
