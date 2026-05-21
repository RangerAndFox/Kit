// @ts-nocheck
/**
 * Standalone HMAC verification sanity test for src/lib/integrations/plaud.ts.
 *
 * Run with: npx tsx scripts/test-plaud-signature.ts
 *
 * The codebase has no Vitest/Jest harness today; this is a deliberate
 * lightweight smoke test for the one piece of code in the Plaud migration
 * that is fully testable without live Plaud credentials.
 */

import crypto from 'crypto'
import { verifyPlaudSignature, isTimestampFresh } from '../src/lib/integrations/plaud'

const SECRET = 'whsec_test_secret_value'
const TIMESTAMP = '2026-05-21T15:30:00Z'
const BODY = JSON.stringify({
  event: 'transcription.completed',
  timestamp: TIMESTAMP,
  data: { transcription_id: 'task_abc', file_id: 'file_xyz', language: 'en', duration: 120, word_count: 240 },
})

function sign(secret: string, timestamp: string, body: string): string {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `sha256=${mac}`
}

const VALID_SIG = sign(SECRET, TIMESTAMP, BODY)

const checks: Array<[string, boolean]> = [
  ['valid signature passes',
    verifyPlaudSignature(BODY, TIMESTAMP, VALID_SIG, SECRET) === true],

  ['wrong secret fails',
    verifyPlaudSignature(BODY, TIMESTAMP, VALID_SIG, 'wrong_secret') === false],

  ['tampered body fails',
    verifyPlaudSignature(BODY + '{}', TIMESTAMP, VALID_SIG, SECRET) === false],

  ['missing sha256= prefix fails',
    verifyPlaudSignature(BODY, TIMESTAMP, VALID_SIG.slice('sha256='.length), SECRET) === false],

  ['empty inputs fail',
    verifyPlaudSignature('', TIMESTAMP, VALID_SIG, SECRET) === false &&
    verifyPlaudSignature(BODY, '', VALID_SIG, SECRET) === false &&
    verifyPlaudSignature(BODY, TIMESTAMP, '', SECRET) === false &&
    verifyPlaudSignature(BODY, TIMESTAMP, VALID_SIG, '') === false],

  ['non-hex signature fails',
    verifyPlaudSignature(BODY, TIMESTAMP, 'sha256=ZZZZ', SECRET) === false],

  ['fresh timestamp passes',
    isTimestampFresh(new Date().toISOString()) === true],

  ['stale timestamp (1 hour old) fails',
    isTimestampFresh(new Date(Date.now() - 3600_000).toISOString()) === false],

  ['malformed timestamp fails',
    isTimestampFresh('not-a-date') === false],
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed++
}
if (failed) {
  console.error(`\n${failed} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll Plaud signature checks passed.')
