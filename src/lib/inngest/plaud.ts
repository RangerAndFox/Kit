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

    // Always write the skeleton row first so we have a record even if the
    // hydrate step fails.
    await step.run('upsert-skeleton', async () => {
      // Insert-only: if a row already exists (idempotency window expired
      // and Plaud is re-delivering the same event), do not touch it. The
      // event payload always carries the same IDs, so DO NOTHING preserves
      // any already-progressed ingest_status (e.g. 'ingested') instead of
      // regressing it back to 'pending'.
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
          { onConflict: 'external_recording_id', ignoreDuplicates: true },
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
    //
    // KNOWN LIMITATION: `workspaceId` is required by TriggerContext but
    // is not yet derivable here — the transcript hasn't been classified.
    // The escape hatch is KIT_DEFAULT_WORKSPACE_ID, an env var the operator
    // sets when activating the flag. We fail loudly if it's unset rather
    // than landing empty-string FKs into sessions. Tracked in spec §10.
    const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
    if (!workspaceId) {
      throw new Error(
        'KIT_DEFAULT_WORKSPACE_ID is required when PLAUD_INGEST_ENABLED=true',
      )
    }

    await step.run('route-to-call-processor', () =>
      routeWebhook('transcript', {
        workspaceId,
        // `source` lives at both levels intentionally: this top-level value
        // is consumed by session-manager for session metadata, while the
        // payload-level value is read by the route's buildPrompt to phrase
        // the agent's prompt ("Process this meeting transcript from <source>").
        source: 'plaud',
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
      // Insert-only: if a row already exists (idempotency window expired
      // and Plaud is re-delivering the same event), do not touch it. The
      // event payload always carries the same IDs, so DO NOTHING preserves
      // any already-progressed ingest_status instead of regressing it back
      // to 'failed'.
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
          { onConflict: 'external_recording_id', ignoreDuplicates: true },
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
