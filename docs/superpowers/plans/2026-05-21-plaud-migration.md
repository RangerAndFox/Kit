# Plaud Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Granola transcript integration with a skeleton Plaud webhook endpoint — full HMAC-SHA256 signature verification live, Plaud Transcription API fetch + RAG ingest gated behind a feature flag for activation once credentials exist.

**Architecture:** `POST /api/webhooks/plaud` verifies HMAC and dispatches the event to Inngest. Two Inngest functions (`plaud-transcription-ready`, `plaud-transcription-failed`) handle the async work. When `PLAUD_INGEST_ENABLED=false` (default), the ready function inserts a skeleton row in the existing `call_transcripts` table — provider-agnostic after this PR's schema rename. When the flag flips on, the function fetches via Plaud's Transcription API and hands off to the existing CALL_PROCESSOR managed agent for RAG ingest.

**Tech Stack:** Next.js App Router (route handler with raw-body HMAC), Inngest v4 (event-triggered functions), Supabase Postgres (schema migration + admin client), Node crypto module (HMAC-SHA256), `tsx` for the standalone HMAC sanity script.

**Spec:** `docs/superpowers/specs/2026-05-21-plaud-migration-design.md`

---

## Conventions used throughout

- All TypeScript files in this repo use `// @ts-nocheck` at the top. Honor that convention.
- Supabase migrations live in `supabase/migrations/` and use numeric prefix `NNN_descriptor.sql`. The next number is `014`.
- Inngest functions are created with `inngest.createFunction({id, name, retries, triggers: [{event}]}, handler)` and registered in `src/app/api/inngest/route.ts`.
- Commits should be small and titled with conventional-commit prefixes: `feat:`, `chore:`, `refactor:`, `db:`. Project uses LF-or-CRLF lenient git config — warnings about line endings are fine to ignore.

---

## Task 1: Housekeeping — gitignore the brainstorm session dir

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Inspect current .gitignore**

```bash
grep -n "superpowers\|^\.superpowers" .gitignore || echo "absent"
```

If output is `absent`, proceed. If `.superpowers/` is already present, skip Task 1 entirely.

- [ ] **Step 2: Append the rule**

Add the following lines to the end of `.gitignore`:

```
# Brainstorm session files from superpowers/brainstorming skill
.superpowers/
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore .superpowers/ brainstorm session dir"
```

---

## Task 2: Supabase migration — generalize call_transcripts + delete legacy Granola rows

**Files:**
- Create: `supabase/migrations/014_plaud_migration.sql`

- [ ] **Step 1: Inspect the existing call_transcripts schema**

```bash
grep -rn "call_transcripts" supabase/migrations/ | head -20
```

Confirm `granola_call_id` exists and identify its constraints (likely unique). The grep output should be enough — do not run live SQL against the database.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/014_plaud_migration.sql` with this exact content:

```sql
-- 014_plaud_migration.sql
-- Generalize call_transcripts for provider-agnostic transcript ingestion.
-- Replaces the Granola integration with Plaud (https://plaud.ai).
-- Spec: docs/superpowers/specs/2026-05-21-plaud-migration-design.md

begin;

-- Rename to a provider-neutral column name.
alter table public.call_transcripts
  rename column granola_call_id to external_recording_id;

-- New columns for Plaud's two-id model and ingest status tracking.
alter table public.call_transcripts
  add column if not exists external_file_id text;

alter table public.call_transcripts
  add column if not exists ingest_status text not null default 'pending'
    check (ingest_status in ('pending', 'ingested', 'failed'));

-- Skeleton rows arrive with IDs only; fields below get hydrated later.
alter table public.call_transcripts alter column transcript drop not null;
alter table public.call_transcripts alter column participants drop not null;
alter table public.call_transcripts alter column start_time drop not null;
alter table public.call_transcripts alter column end_time drop not null;

-- Ensure uniqueness on the recording id (safe if a unique constraint
-- carried over from the rename — IF NOT EXISTS makes this idempotent).
create unique index if not exists call_transcripts_external_recording_id_key
  on public.call_transcripts (external_recording_id);

create index if not exists call_transcripts_source_ingest_status_idx
  on public.call_transcripts (source, ingest_status);

-- Hard-delete legacy Granola rows. RAG documents tied to them are not
-- reachable through a foreign key and stay in project_documents as
-- source-agnostic text+embeddings (documented trade-off in the spec).
delete from public.call_transcripts where source = 'granola';

commit;
```

- [ ] **Step 3: Sanity-check the SQL parses**

```bash
# Optional: if psql is available locally with a Supabase-mirrored DB,
# run a dry parse. Otherwise rely on the Supabase CLI/UI to apply.
psql --version >/dev/null 2>&1 && echo "psql available — caller can dry-run; skipping in plan"
```

Do not apply the migration in this step. Application is part of the rollout, after the PR merges.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/014_plaud_migration.sql
git commit -m "db: 014_plaud_migration — generalize call_transcripts + drop granola rows"
```

---

## Task 3: Plaud integration module + standalone HMAC sanity script

**Files:**
- Create: `src/lib/integrations/plaud.ts`
- Create: `scripts/test-plaud-signature.ts`

This task ships the HMAC verification primitive with a runnable sanity check, since the codebase has no test framework wired up.

- [ ] **Step 1: Write the integration module**

Create `src/lib/integrations/plaud.ts`:

```ts
// @ts-nocheck
/**
 * Plaud (https://plaud.ai) integration.
 *
 * Webhook verification: HMAC-SHA256 over `${timestamp}.${rawBody}`, compared
 * against the `plaud-signature` header (format: `sha256=<hex>`).
 * Spec: https://docs.plaud.ai/documentation/embedded_sdk/webhooks.md
 *
 * Transcription API fetches are stubbed and gated by PLAUD_INGEST_ENABLED.
 * When the flag is off they throw — callers must check the flag first.
 */

import crypto from 'crypto'

// ─── Types ────────────────────────────────────────────────────

export interface PlaudTranscriptionCompletedEvent {
  event: 'transcription.completed'
  timestamp: string
  data: {
    transcription_id: string
    file_id: string
    language: string
    duration: number
    word_count: number
  }
}

export interface PlaudTranscriptionFailedEvent {
  event: 'transcription.failed'
  timestamp: string
  data: {
    transcription_id: string
    file_id: string
    error: string
    message: string
  }
}

export type PlaudWebhookEvent =
  | PlaudTranscriptionCompletedEvent
  | PlaudTranscriptionFailedEvent

export interface PlaudTranscript {
  text: string
  speakers: Array<{
    speaker_label: string
    text: string
    start_seconds: number
    end_seconds: number
  }>
}

export interface PlaudFile {
  name: string
  duration_seconds: number
  created_at: string
  participants?: string[]
}

// ─── Signature verification ───────────────────────────────────

/**
 * Constant-time HMAC-SHA256 verification of a Plaud webhook.
 *
 * Plaud signs `${timestamp}.${rawBody}` with the webhook secret and sends
 * the result as `sha256=<hex>` in the `plaud-signature` header.
 *
 * Returns false on any malformed input rather than throwing — callers
 * just need a boolean.
 */
export function verifyPlaudSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string,
): boolean {
  if (!rawBody || !timestamp || !signature || !secret) return false
  if (!signature.startsWith('sha256=')) return false

  const provided = signature.slice('sha256='.length)
  if (!/^[0-9a-f]+$/i.test(provided)) return false

  const message = `${timestamp}.${rawBody}`
  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex')

  if (provided.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided, 'hex'),
      Buffer.from(expected, 'hex'),
    )
  } catch {
    return false
  }
}

/**
 * Check the plaud-timestamp header is recent enough to reject capture-replays.
 * Default window is 300 seconds; override with PLAUD_TIMESTAMP_SKEW_SECONDS.
 */
export function isTimestampFresh(timestamp: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(timestamp)
  if (Number.isNaN(ts)) return false
  const skewSeconds = Number(process.env.PLAUD_TIMESTAMP_SKEW_SECONDS) || 300
  return Math.abs(nowMs - ts) <= skewSeconds * 1000
}

// ─── Transcription API (flag-gated stubs) ─────────────────────

const PLAUD_API = 'https://api.plaud.ai/v1'

function ingestEnabled(): boolean {
  return process.env.PLAUD_INGEST_ENABLED === 'true'
}

function plaudHeaders(): Record<string, string> {
  const key = process.env.PLAUD_API_KEY
  if (!key) {
    throw new Error('PLAUD_API_KEY is required when PLAUD_INGEST_ENABLED=true')
  }
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
}

/**
 * Fetch a transcript by transcription_id. Stubbed today: throws when the
 * ingest flag is off so callers can branch cleanly.
 *
 * When the flag flips on, this calls the Plaud Transcription API.
 * Exact endpoint and response shape need to be confirmed against
 * https://docs.plaud.ai/documentation/embedded_sdk/transcription_api.md
 * once we have a working dev app.
 */
export async function fetchPlaudTranscript(
  transcriptionId: string,
): Promise<PlaudTranscript> {
  if (!ingestEnabled()) {
    throw new Error('PLAUD_INGEST_ENABLED is false — Plaud fetch path is disabled')
  }
  const res = await fetch(`${PLAUD_API}/transcriptions/${transcriptionId}`, {
    method: 'GET',
    headers: plaudHeaders(),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    throw new Error(`Plaud transcript fetch ${res.status}: ${await res.text().catch(() => '')}`)
  }
  return (await res.json()) as PlaudTranscript
}

/**
 * Fetch file metadata (name, duration, participants if Plaud surfaces them).
 * Same flag-gating + endpoint-pending-confirmation note as fetchPlaudTranscript.
 */
export async function fetchPlaudFile(fileId: string): Promise<PlaudFile> {
  if (!ingestEnabled()) {
    throw new Error('PLAUD_INGEST_ENABLED is false — Plaud fetch path is disabled')
  }
  const res = await fetch(`${PLAUD_API}/files/${fileId}`, {
    method: 'GET',
    headers: plaudHeaders(),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`Plaud file fetch ${res.status}: ${await res.text().catch(() => '')}`)
  }
  return (await res.json()) as PlaudFile
}
```

- [ ] **Step 2: Write a standalone HMAC sanity script**

Create `scripts/test-plaud-signature.ts`:

```ts
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
```

- [ ] **Step 3: Run the sanity script**

```bash
npx tsx scripts/test-plaud-signature.ts
```

Expected output: all 9 lines reading `PASS`, ending with `All Plaud signature checks passed.` If `tsx` is not installed, install it locally:

```bash
npm install -D tsx
```

…then re-run.

- [ ] **Step 4: Commit**

```bash
git add src/lib/integrations/plaud.ts scripts/test-plaud-signature.ts
git commit -m "feat: Plaud integration module with HMAC verification"
```

If `package.json` changed because `tsx` was installed, add it as well:

```bash
git add package.json package-lock.json
git commit --amend --no-edit
```

(Amend is acceptable here because the prior commit has not been pushed.)

---

## Task 4: Inngest functions — plaud-transcription-ready + plaud-transcription-failed

**Files:**
- Create: `src/lib/inngest/plaud.ts`

- [ ] **Step 1: Write the Inngest functions**

Create `src/lib/inngest/plaud.ts`:

```ts
// @ts-nocheck
/**
 * Plaud Inngest functions.
 *
 * Triggered by /api/webhooks/plaud after HMAC verification.
 * Spec: docs/superpowers/specs/2026-05-21-plaud-migration-design.md
 *
 * Today (PLAUD_INGEST_ENABLED=false): inserts skeleton call_transcripts
 * rows with IDs only. The hydrated-ingest path is here but inactive.
 *
 * When the flag flips on: hydrates rows by calling Plaud's Transcription
 * API, then routes through the existing webhook-router 'transcript' entry
 * so the CALL_PROCESSOR managed agent does classification + RAG ingest.
 */

import { inngest } from './client'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchPlaudFile, fetchPlaudTranscript } from '@/lib/integrations/plaud'
import { routeWebhook } from '@/lib/managed-agents/webhook-router'

const SLACK_API = 'https://slack.com/api'

function ingestEnabled(): boolean {
  return process.env.PLAUD_INGEST_ENABLED === 'true'
}

async function postPlaudErrorNotice(text: string): Promise<void> {
  const channel = process.env.PLAUD_ERROR_CHANNEL_ID
  const token = process.env.SLACK_BOT_TOKEN
  if (!channel || !token) return
  await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, text }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {})
}

// ─── plaud/transcription.ready ───────────────────────────────

export const plaudTranscriptionReady = inngest.createFunction(
  {
    id: 'plaud-transcription-ready',
    name: 'Plaud — Transcription Ready',
    retries: 2,
    // Idempotency on the transcription_id keeps Plaud's retry storm
    // (30s, 5m, 30m, 2h, 24h) from creating duplicate rows.
    idempotency: 'event.data.transcription_id',
    triggers: [{ event: 'plaud/transcription.ready' }],
  },
  async ({ event, step }) => {
    const data = event.data as {
      transcription_id: string
      file_id: string
      language?: string
      duration?: number
      word_count?: number
    }

    const sb = createAdminClient()

    // Always write/refresh the skeleton row first so we have a record
    // even if the hydrate step fails. Use upsert on external_recording_id
    // to make retries safe.
    await step.run('upsert-skeleton', async () => {
      const { error } = await sb
        .from('call_transcripts' as any)
        .upsert(
          {
            external_recording_id: data.transcription_id,
            external_file_id: data.file_id,
            source: 'plaud',
            ingest_status: 'pending',
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'external_recording_id' },
        )
      if (error) throw new Error(`Skeleton upsert failed: ${error.message}`)
    })

    if (!ingestEnabled()) {
      return { hydrated: false, reason: 'PLAUD_INGEST_ENABLED is false' }
    }

    // ── Hydrate path ────────────────────────────────────────
    const file = await step.run('fetch-plaud-file', () => fetchPlaudFile(data.file_id))
    const transcript = await step.run('fetch-plaud-transcript', () =>
      fetchPlaudTranscript(data.transcription_id),
    )

    // Hand off to the generic transcript route. The CALL_PROCESSOR agent
    // is responsible for project classification + RAG ingest.
    await step.run('route-to-call-processor', () =>
      routeWebhook('transcript', {
        payload: {
          transcript: transcript.text,
          source: 'plaud',
          attendees: file.participants ?? [],
          external_recording_id: data.transcription_id,
          external_file_id: data.file_id,
          duration_seconds: file.duration_seconds,
          title: file.name,
          started_at: file.created_at,
        },
        receivedAt: new Date().toISOString(),
      }),
    )

    await step.run('mark-ingested', async () => {
      const { error } = await sb
        .from('call_transcripts' as any)
        .update({
          transcript: transcript.text,
          start_time: file.created_at,
          ingest_status: 'ingested',
          updated_at: new Date().toISOString(),
        })
        .eq('external_recording_id', data.transcription_id)
      if (error) throw new Error(`Mark-ingested failed: ${error.message}`)
    })

    return { hydrated: true }
  },
)

// ─── plaud/transcription.failed ──────────────────────────────

export const plaudTranscriptionFailed = inngest.createFunction(
  {
    id: 'plaud-transcription-failed',
    name: 'Plaud — Transcription Failed',
    retries: 0,
    idempotency: 'event.data.transcription_id',
    triggers: [{ event: 'plaud/transcription.failed' }],
  },
  async ({ event, step }) => {
    const data = event.data as {
      transcription_id: string
      file_id: string
      error: string
      message: string
    }

    const sb = createAdminClient()

    await step.run('record-failure', async () => {
      const { error } = await sb
        .from('call_transcripts' as any)
        .upsert(
          {
            external_recording_id: data.transcription_id,
            external_file_id: data.file_id,
            source: 'plaud',
            ingest_status: 'failed',
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'external_recording_id' },
        )
      if (error) throw new Error(`Record-failure upsert failed: ${error.message}`)
    })

    await step.run('notify-slack', () =>
      postPlaudErrorNotice(
        `:warning: Plaud transcription failed for \`${data.transcription_id}\`\n*${data.error}* — ${data.message}`,
      ),
    )

    return { recorded: true }
  },
)
```

- [ ] **Step 2: Type-check the project**

```bash
npx tsc --noEmit
```

Expected: no new errors. (All Kit files carry `// @ts-nocheck`, so this is mostly a "did I break import paths" check.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/inngest/plaud.ts
git commit -m "feat: Plaud Inngest functions (transcription.ready/failed)"
```

---

## Task 5: Webhook route — POST /api/webhooks/plaud

**Files:**
- Create: `src/app/api/webhooks/plaud/route.ts`

- [ ] **Step 1: Write the route handler**

Create `src/app/api/webhooks/plaud/route.ts`:

```ts
// @ts-nocheck
/**
 * Plaud webhook receiver.
 *
 * Plaud sends `transcription.completed` and `transcription.failed` events.
 * Spec: docs/superpowers/specs/2026-05-21-plaud-migration-design.md
 *
 * This route does only signature verification, replay protection, and
 * Inngest dispatch. All real work happens inside the Inngest functions
 * defined in src/lib/inngest/plaud.ts so we can return 200 inside Plaud's
 * 10-second webhook timeout.
 */

import type { NextRequest } from 'next/server'
import { inngest } from '@/lib/inngest/client'
import { verifyPlaudSignature, isTimestampFresh } from '@/lib/integrations/plaud'

export async function POST(request: NextRequest) {
  const secret = process.env.PLAUD_WEBHOOK_SECRET
  if (!secret) {
    console.error('[plaud-webhook] PLAUD_WEBHOOK_SECRET is not set')
    return Response.json({ error: 'webhook not configured' }, { status: 500 })
  }

  // Raw body needed for HMAC. Do not JSON.parse before verifying.
  const rawBody = await request.text()
  const signature = request.headers.get('plaud-signature') || ''
  const timestamp = request.headers.get('plaud-timestamp') || ''

  if (!verifyPlaudSignature(rawBody, timestamp, signature, secret)) {
    console.warn('[plaud-webhook] bad signature')
    return Response.json({ error: 'invalid signature' }, { status: 401 })
  }

  if (!isTimestampFresh(timestamp)) {
    console.warn(`[plaud-webhook] stale timestamp ${timestamp}`)
    return Response.json({ error: 'stale timestamp' }, { status: 401 })
  }

  let body: any
  try {
    body = JSON.parse(rawBody)
  } catch (err) {
    console.warn('[plaud-webhook] malformed JSON', err)
    return Response.json({ error: 'invalid json' }, { status: 400 })
  }

  const eventName = body?.event
  const data = body?.data

  if (!eventName || !data) {
    return Response.json({ error: 'missing event or data' }, { status: 400 })
  }

  // Dispatch to Inngest. Unknown events log + 200 (forward compatibility).
  switch (eventName) {
    case 'transcription.completed':
      await inngest.send({
        name: 'plaud/transcription.ready',
        data,
      })
      break
    case 'transcription.failed':
      await inngest.send({
        name: 'plaud/transcription.failed',
        data,
      })
      break
    default:
      console.log(`[plaud-webhook] unknown event '${eventName}' — acknowledged but not dispatched`)
  }

  return Response.json({ received: true }, { status: 200 })
}
```

- [ ] **Step 2: Smoke-test the route handler against a local Next.js dev server**

In one terminal:

```bash
npm run dev
```

In another terminal, send a forged-signature request (must be rejected with 401):

```bash
curl -i -X POST http://localhost:3000/api/webhooks/plaud \
  -H "Content-Type: application/json" \
  -H "plaud-signature: sha256=deadbeef" \
  -H "plaud-timestamp: 2026-05-21T15:30:00Z" \
  -d '{"event":"transcription.completed","data":{"transcription_id":"t1","file_id":"f1"}}'
```

Expected: `HTTP/1.1 401 Unauthorized` and body `{"error":"invalid signature"}`.

Then send a properly signed request (must return 200). Generate the signature inline with Node:

```bash
PLAUD_BODY='{"event":"transcription.completed","timestamp":"2026-05-21T15:30:00Z","data":{"transcription_id":"t1","file_id":"f1"}}'
PLAUD_TS="2026-05-21T15:30:00Z"
PLAUD_SECRET="$PLAUD_WEBHOOK_SECRET"  # set this in your local .env.local first
PLAUD_SIG=$(node -e "console.log('sha256='+require('crypto').createHmac('sha256', process.argv[1]).update(process.argv[2]+'.'+process.argv[3]).digest('hex'))" "$PLAUD_SECRET" "$PLAUD_TS" "$PLAUD_BODY")

curl -i -X POST http://localhost:3000/api/webhooks/plaud \
  -H "Content-Type: application/json" \
  -H "plaud-signature: $PLAUD_SIG" \
  -H "plaud-timestamp: $PLAUD_TS" \
  -d "$PLAUD_BODY"
```

Expected: `HTTP/1.1 200 OK` and body `{"received":true}`. Note the dev server's log line `[plaud-webhook]` should be absent — only the bad-signature test logs.

If `PLAUD_WEBHOOK_SECRET` is not in `.env.local` yet, set it to any temporary value for this smoke test:

```bash
echo 'PLAUD_WEBHOOK_SECRET=whsec_local_dev_only' >> .env.local
```

Then restart the dev server. (Do **not** commit `.env.local`.)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/webhooks/plaud/route.ts
git commit -m "feat: POST /api/webhooks/plaud with HMAC verification"
```

---

## Task 6: Register Inngest functions

**Files:**
- Modify: `src/app/api/inngest/route.ts`

- [ ] **Step 1: Inspect the current registration**

```bash
cat src/app/api/inngest/route.ts
```

The file imports `provisionProject` and lists it in the `functions` array of `serve()`. New imports go alongside; new functions get appended to the array.

- [ ] **Step 2: Apply the edit**

Update `src/app/api/inngest/route.ts` to look exactly like this:

```ts
// @ts-nocheck
import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'
import { provisionProject } from '@/lib/inngest/orchestrator'
import { plaudTranscriptionReady, plaudTranscriptionFailed } from '@/lib/inngest/plaud'

/**
 * Inngest API route.
 *
 * Inngest's serve() adapter handles:
 *   - Function registration (POST /api/inngest)
 *   - Step execution callbacks
 *   - Health checks
 *
 * All Kit Inngest functions are registered here.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    provisionProject,
    plaudTranscriptionReady,
    plaudTranscriptionFailed,
    // Add new functions here as agents are built
  ],
})
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Verify Inngest registration locally (optional but recommended)**

If you have the Inngest dev server installed:

```bash
npx inngest-cli@latest dev
# then in another terminal:
npm run dev
```

Browse the Inngest dev UI (default http://localhost:8288) and confirm that `plaud-transcription-ready` and `plaud-transcription-failed` appear in the function list.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/inngest/route.ts
git commit -m "chore: register Plaud Inngest functions"
```

---

## Task 7: Integration registry — Granola → Plaud

**Files:**
- Modify: `src/lib/integrations/registry.ts`

- [ ] **Step 1: Apply the edit**

Locate the Granola entry (currently around lines 172–179 in the Transcription block):

```ts
  {
    id: 'granola',
    name: 'Granola',
    category: 'transcription',
    description: 'Meeting transcription and highlights',
    icon: 'Mic',
    status: 'available',
    requiresOAuth: false,
  },
```

Replace it with:

```ts
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
```

(`requiresOAuth: true` because the developer app is OAuth-based; `status: 'beta'` because we're shipping the skeleton.)

- [ ] **Step 2: Confirm no other references to the old id**

```bash
grep -rn "'granola'" src/ supabase/ scripts/ docs/ --exclude-dir=node_modules || echo "clean"
```

Expected: `clean`. If anything turns up outside the legacy migration SQL (in `supabase/migrations/`, which is history and should not be edited), handle it now.

- [ ] **Step 3: Commit**

```bash
git add src/lib/integrations/registry.ts
git commit -m "refactor: replace Granola integration entry with Plaud in registry"
```

---

## Task 8: Settings UI — integrations + security pages

**Files:**
- Modify: `src/app/(app)/settings/integrations/page.tsx`
- Modify: `src/app/(app)/settings/security/page.tsx`

- [ ] **Step 1: Inspect the current Granola references**

```bash
grep -n "[Gg]ranola" "src/app/(app)/settings/integrations/page.tsx" "src/app/(app)/settings/security/page.tsx"
```

Expected hits:
- `settings/integrations/page.tsx:10` — a sample integration row
- `settings/security/page.tsx:9` — a domain pattern in the founder-stream whitelist

- [ ] **Step 2: Edit `settings/integrations/page.tsx`**

Find the line:

```ts
  { name: 'Granola', category: 'Transcription', description: 'Founder-stream transcript ingestion', connected: false },
```

Replace it with:

```ts
  { name: 'Plaud', category: 'Transcription', description: 'Hardware AI recorder — meeting transcripts via webhook (https://docs.plaud.ai/)', connected: false },
```

- [ ] **Step 3: Edit `settings/security/page.tsx`**

Find the line:

```ts
  { id: '3', type: 'domain', pattern: 'granola.ai', stream: 'founder' },
```

Replace it with:

```ts
  { id: '3', type: 'domain', pattern: 'plaud.ai', stream: 'founder' },
```

- [ ] **Step 4: Visually verify in the dev server (optional)**

```bash
npm run dev
```

Browse to `/settings/integrations` — confirm the Plaud row appears in place of Granola. Browse to `/settings/security` — confirm `plaud.ai` appears in the founder-domain list.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/settings/integrations/page.tsx" "src/app/(app)/settings/security/page.tsx"
git commit -m "refactor: settings UI references Plaud instead of Granola"
```

---

## Task 9: Call classifier — generalize source switch

**Files:**
- Modify: `src/lib/agent/call-classifier.ts` (around lines 50–51)

- [ ] **Step 1: Read the relevant block**

```bash
sed -n '40,80p' src/lib/agent/call-classifier.ts
```

This will show the `source === 'granola'` branch and what it sets (likely `stream === 'founder'`).

- [ ] **Step 2: Apply the edit**

Replace the block that begins with the comment `// Granola is a founder-focused transcription service` and the `if (source === 'granola') {` line. Update both lines:

- Old (current):
  ```ts
    // Granola is a founder-focused transcription service
    if (source === 'granola') {
  ```
- New:
  ```ts
    // Plaud is our hardware meeting recorder; transcripts default to the founder stream.
    if (source === 'plaud') {
  ```

Leave the body of the `if` block unchanged — same routing intent.

- [ ] **Step 3: Sanity grep**

```bash
grep -n "granola" src/lib/agent/call-classifier.ts || echo "clean"
```

Expected: `clean`.

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/call-classifier.ts
git commit -m "refactor: call-classifier routes Plaud source to founder stream"
```

---

## Task 10: Webhook router comment — Granola → Plaud

**Files:**
- Modify: `src/lib/managed-agents/webhook-router.ts` (around line 25)

- [ ] **Step 1: Apply the edit**

Find the comment in the `routes` object:

```ts
  // Transcription services (Granola, Otter, etc.)
```

Replace with:

```ts
  // Transcription services (Plaud, Otter, etc.)
```

The route handler logic itself is provider-agnostic and stays.

- [ ] **Step 2: Commit**

```bash
git add src/lib/managed-agents/webhook-router.ts
git commit -m "chore: update webhook-router comment for Plaud"
```

---

## Task 11: Delete `src/lib/integrations/granola.ts`

**Files:**
- Delete: `src/lib/integrations/granola.ts`

This file's only export, `processGranolaTranscript`, was never referenced from live code paths — confirmed during spec exploration. Removing it is safe.

- [ ] **Step 1: Final reference check**

```bash
grep -rn "processGranolaTranscript\|integrations/granola" src/ --exclude-dir=node_modules || echo "no references — safe to delete"
```

Expected: `no references — safe to delete`. If anything turns up (e.g. an import in a file you missed), fix the caller before deleting.

- [ ] **Step 2: Delete the file**

```bash
git rm src/lib/integrations/granola.ts
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: delete unused granola integration module"
```

---

## Task 12: Update docs and `.env.example`

**Files:**
- Modify: `.env.example` (create the file if it doesn't exist)
- Modify: `README.md`

- [ ] **Step 1: Find existing Granola env-var documentation**

```bash
grep -n "GRANOLA\|granola" .env.example README.md 2>/dev/null || echo "no existing references"
```

If `no existing references`, skip the removal substeps below — just append the Plaud block.

- [ ] **Step 2: Edit `.env.example`**

Remove any `GRANOLA_*` lines. Append the following block:

```
# ─── Plaud (https://plaud.ai) — meeting transcription ────────
# Webhook signing secret (required for any webhook traffic to be accepted)
PLAUD_WEBHOOK_SECRET=
# API key for the Plaud Transcription API. Required only when PLAUD_INGEST_ENABLED=true.
PLAUD_API_KEY=
# Master switch for the transcript-fetch + RAG ingest path. Leave 'false' until
# you have a working Plaud dev app and a verified webhook test run.
PLAUD_INGEST_ENABLED=false
# Replay-protection window for plaud-timestamp header, in seconds.
PLAUD_TIMESTAMP_SKEW_SECONDS=300
# Optional Slack channel id for transcription.failed notices.
PLAUD_ERROR_CHANNEL_ID=
```

- [ ] **Step 3: Edit `README.md`**

Locate the "Webhook integrations" or equivalent section. Remove the Granola row (if any). Add a Plaud row using this language:

```markdown
### Plaud — meeting transcription

Plaud (https://plaud.ai) sends transcription events to `POST /api/webhooks/plaud`. Setup:

1. Create a dev app in the Plaud developer console.
2. Copy the webhook signing secret into `PLAUD_WEBHOOK_SECRET`.
3. Copy the API token into `PLAUD_API_KEY`.
4. Leave `PLAUD_INGEST_ENABLED=false` until you've verified a real recording produces a skeleton row in `call_transcripts`.
5. Once verified, flip `PLAUD_INGEST_ENABLED=true` to enable transcript fetch + RAG ingest. Backfill any pending skeleton rows by re-firing their `transcription.completed` events from the Plaud console.

Docs: https://docs.plaud.ai/
```

If `README.md` has no integrations section, insert the block above into the most natural neighbouring section (typically near other webhook setup notes); do not invent a new top-level section just for this.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: replace Granola with Plaud in env example and README"
```

---

## Task 13: Final sweep — grep for any lingering Granola references

**Files:** none (verification step only)

- [ ] **Step 1: Search everything except node_modules and historical migrations**

```bash
grep -rn -i "granola" \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude-dir=.git \
  --exclude-dir=.superpowers \
  --exclude="supabase/migrations/*.sql" \
  . || echo "clean"
```

Expected: `clean`. If anything turns up, decide whether it's legacy data documentation (leave alone) or a live reference (fix and commit separately as `chore: remove residual Granola reference in <file>`).

- [ ] **Step 2: Final type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Final HMAC sanity script run**

```bash
npx tsx scripts/test-plaud-signature.ts
```

Expected: all checks `PASS`.

- [ ] **Step 4: Confirm the commit graph**

```bash
git log --oneline -15
```

Expected to see (in order from oldest to newest in this PR):

1. `chore: gitignore .superpowers/ brainstorm session dir` (Task 1)
2. `db: 014_plaud_migration — generalize call_transcripts + drop granola rows` (Task 2)
3. `feat: Plaud integration module with HMAC verification` (Task 3)
4. `feat: Plaud Inngest functions (transcription.ready/failed)` (Task 4)
5. `feat: POST /api/webhooks/plaud with HMAC verification` (Task 5)
6. `chore: register Plaud Inngest functions` (Task 6)
7. `refactor: replace Granola integration entry with Plaud in registry` (Task 7)
8. `refactor: settings UI references Plaud instead of Granola` (Task 8)
9. `refactor: call-classifier routes Plaud source to founder stream` (Task 9)
10. `chore: update webhook-router comment for Plaud` (Task 10)
11. `chore: delete unused granola integration module` (Task 11)
12. `docs: replace Granola with Plaud in env example and README` (Task 12)

Twelve focused commits. If any are missing or in the wrong order, do not rewrite history — note the discrepancy and move on. The next PR (pre-meeting briefings) builds on this baseline.

---

## Definition of Done

- All 13 tasks above checked off.
- `npx tsc --noEmit` passes.
- `npx tsx scripts/test-plaud-signature.ts` passes.
- Local dev-server smoke test from Task 5 shows 401 on forged signature and 200 on valid signature.
- `grep -rn -i "granola" --exclude-dir=node_modules --exclude="supabase/migrations/*.sql"` returns nothing.
- Migration `014_plaud_migration.sql` is present and committed but **not yet applied** to the database — applying it is part of rollout, not this PR.

## Rollout (after PR merges — outside this plan)

1. Apply migration `014_plaud_migration.sql` via Supabase CLI/UI.
2. Operator creates a Plaud developer app and configures the webhook URL = `https://<prod-host>/api/webhooks/plaud`.
3. Copy webhook secret and API key into Railway as `PLAUD_WEBHOOK_SECRET` and `PLAUD_API_KEY`. Leave `PLAUD_INGEST_ENABLED=false`.
4. Record a 30-second Plaud test note. Verify a row appears in `call_transcripts` with `source='plaud'`, `ingest_status='pending'`, and the correct `external_recording_id` and `external_file_id`.
5. Flip `PLAUD_INGEST_ENABLED=true` in Railway. Trigger another recording (or replay the webhook from Plaud's console). Verify the existing row updates to `ingest_status='ingested'` with transcript text, and that a corresponding RAG document is created.
6. Optionally backfill `pending` skeleton rows by replaying their `transcription.completed` events from the Plaud console.
