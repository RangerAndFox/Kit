// @ts-nocheck
/** Direct Plaud transcript scan using Plaud's personal-recording OAuth API. */

import { inngest } from './client'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  plaudIngestEnabled,
  listPlaudRecordings,
  filterPlaudRecordingsSince,
  getPlaudRecording,
  extractPlaudTranscript,
} from '@/lib/integrations/plaud'
import { matchTranscriptToProject } from '@/lib/agent/call-classifier'
import { embedTranscript } from '@/lib/studio-knowledge/transcript'
import { recordCronSuccess } from '@/lib/health/state'

const MAX_PER_RUN = 10

export const plaudTranscriptScan = inngest.createFunction(
  {
    id: 'plaud-transcript-scan',
    name: 'Plaud — Ingest completed recordings directly',
    retries: 2,
    concurrency: 1,
    triggers: [{ cron: '7,22,37,52 * * * *' }],
  },
  async ({ step }) => {
    if (!plaudIngestEnabled()) {
      return { skipped: true, reason: 'PLAUD_INGEST_ENABLED is false' }
    }
    const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
    if (!workspaceId) throw new Error('KIT_DEFAULT_WORKSPACE_ID is required for Plaud ingestion')

    const candidates = await step.run('find-new-plaud-recordings', async () => {
      const accountFiles = []
      // Bound the scan to 500 newest recordings. A 100-item page is Plaud's
      // documented maximum; most runs stop after page one.
      for (let page = 1; page <= 5; page++) {
        const batch = await listPlaudRecordings(page, 100)
        accountFiles.push(...batch)
        if (batch.length < 100) break
      }
      const files = filterPlaudRecordingsSince(accountFiles)
      if (files.length === 0) return []
      const ids = files.map((file) => `plaud:${file.id}`)
      const { data: existing, error } = await createAdminClient()
        .from('call_transcripts')
        .select('external_recording_id, ingest_status')
        .in('external_recording_id', ids)
      if (error) throw new Error(`Plaud duplicate check failed: ${error.message}`)
      const complete = new Set(
        (existing || [])
          .filter((row: any) => row.ingest_status === 'ingested')
          .map((row: any) => row.external_recording_id),
      )
      return files
        .filter((file) => !complete.has(`plaud:${file.id}`))
        .slice(0, MAX_PER_RUN)
    })

    let ingested = 0
    let awaitingTranscript = 0
    for (const candidate of candidates) {
      const result = await step.run(`ingest-plaud-${candidate.id}`, async () => {
        const recording = await getPlaudRecording(candidate.id)
        const parsed = await extractPlaudTranscript(recording)
        // A synced recording can appear before Plaud finishes its transcript.
        // Leave it unclaimed so the next scan naturally retries it.
        if (!parsed.text) return 'awaiting-transcript'

        const sb = createAdminClient()
        const externalId = `plaud:${recording.id}`
        const startTime = recording.start_at || recording.created_at || null
        const durationSeconds = Number.isFinite(Number(recording.duration))
          ? Math.round(Number(recording.duration) / 1000)
          : null
        const endTime = startTime && durationSeconds
          ? new Date(Date.parse(startTime) + durationSeconds * 1000).toISOString()
          : null

        const { data: row, error } = await sb
          .from('call_transcripts')
          .upsert(
            {
              workspace_id: workspaceId,
              source: 'plaud',
              external_recording_id: externalId,
              external_file_id: recording.id,
              transcript: parsed.text,
              participants: parsed.participants,
              duration_seconds: durationSeconds,
              start_time: startTime,
              end_time: endTime,
              ingest_status: 'pending',
              ingest_error: null,
              project_match_attempted_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'external_recording_id' },
          )
          .select('id, project_id')
          .single()
        if (error) throw new Error(`Plaud transcript upsert failed: ${error.message}`)

        let projectId = row.project_id || null
        if (!projectId) {
          try {
            projectId = await matchTranscriptToProject({
              workspaceId,
              title: recording.name || '',
              transcript: parsed.text,
            })
          } catch (error: any) {
            console.warn(`[plaud-transcripts] project match failed for ${recording.id}: ${error.message}`)
          }
        }

        // A failed replay may already have chunks. Replace only this transcript's
        // chunks before embedding so retries cannot duplicate knowledge results.
        await sb
          .from('project_documents')
          .delete()
          .eq('doc_type', 'call_transcript')
          .filter('metadata->>call_transcripts_id', 'eq', row.id)

        try {
          await embedTranscript({
            id: row.id,
            workspace_id: workspaceId,
            project_id: projectId,
            source: 'plaud',
            transcript: parsed.text,
            participants: parsed.participants,
            start_time: startTime,
            duration_seconds: durationSeconds,
            external_recording_id: externalId,
            external_file_id: recording.id,
          })
        } catch (error: any) {
          await sb
            .from('call_transcripts')
            .update({ ingest_status: 'failed', ingest_error: error.message, updated_at: new Date().toISOString() })
            .eq('id', row.id)
          throw error
        }

        const { error: completeError } = await sb
          .from('call_transcripts')
          .update({
            project_id: projectId,
            ingest_status: 'ingested',
            ingest_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id)
        if (completeError) throw new Error(`Plaud completion update failed: ${completeError.message}`)
        return 'ingested'
      })
      if (result === 'ingested') ingested++
      else awaitingTranscript++
    }

    await step.run('plaud-heartbeat', async () => {
      try { await recordCronSuccess('plaud-transcript-scan') } catch {}
      return true
    })
    return { scanned: candidates.length, ingested, awaitingTranscript }
  },
)
