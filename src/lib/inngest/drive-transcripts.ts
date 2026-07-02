// @ts-nocheck
/**
 * Drive transcript scan — Inngest cron.
 *
 * Every 15 minutes: list the watched Drive folder (Plaud → Zapier drops),
 * ingest any file not seen before through the same pipeline the Plaud
 * webhook path uses — store the call_transcripts row, classify it to a
 * project (matchToProject), embed it into RAG (embedTranscript).
 *
 * Idempotency: external_recording_id = 'drive:<fileId>' is UNIQUE on
 * call_transcripts; the scan batch-checks existing ids and each file's
 * ingest runs in its own memoized step.
 *
 * Downstream consumers light up automatically: briefing "Last meeting"
 * recaps, channel-participation LAST CALL blocks, brain retrieval, and
 * studio-knowledge search.
 */

import { inngest } from './client'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  driveTranscriptsEnabled,
  driveTranscriptsFolderId,
  listTranscriptFiles,
  downloadTranscriptText,
} from '@/lib/integrations/drive-transcripts'
import { matchToProject } from '@/lib/agent/call-classifier'
import { embedTranscript } from '@/lib/studio-knowledge/transcript'

const MAX_PER_RUN = 10

export const driveTranscriptScan = inngest.createFunction(
  {
    id: 'drive-transcript-scan',
    name: 'Drive — Ingest Plaud transcripts from the watched folder',
    retries: 1,
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async ({ step }) => {
    if (!driveTranscriptsEnabled()) {
      return { skipped: true, reason: 'DRIVE_TRANSCRIPTS_ENABLED is false' }
    }
    if (!driveTranscriptsFolderId()) {
      return { skipped: true, reason: 'DRIVE_TRANSCRIPTS_FOLDER_ID is not set' }
    }
    const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
    if (!workspaceId) {
      throw new Error('KIT_DEFAULT_WORKSPACE_ID is required when DRIVE_TRANSCRIPTS_ENABLED=true')
    }

    // One memoized step: list the folder and drop files already ingested.
    const newFiles = await step.run('find-new-files', async () => {
      const files = await listTranscriptFiles(25)
      if (files.length === 0) return []
      const sb = createAdminClient()
      const ids = files.map((f) => `drive:${f.id}`)
      const { data: existing } = await sb
        .from('call_transcripts')
        .select('external_recording_id')
        .in('external_recording_id', ids)
      const seen = new Set((existing || []).map((r: any) => r.external_recording_id))
      return files.filter((f) => !seen.has(`drive:${f.id}`)).slice(0, MAX_PER_RUN)
    })

    if (newFiles.length === 0) return { scanned: 0, ingested: 0 }

    let ingested = 0
    let skipped = 0
    for (const file of newFiles) {
      const result = await step.run(`ingest-${file.id}`, async () => {
        const text = (await downloadTranscriptText(file))?.trim()
        if (!text) {
          console.warn(`[drive-transcripts] unsupported/empty file skipped: ${file.name} (${file.mimeType})`)
          return 'skipped'
        }

        const sb = createAdminClient()
        // Insert first (unique external_recording_id = the idempotency
        // claim). ignoreDuplicates so a replay can't double-insert.
        const { data: inserted, error } = await sb
          .from('call_transcripts')
          .upsert(
            {
              workspace_id: workspaceId,
              source: 'drive',
              external_recording_id: `drive:${file.id}`,
              external_file_id: file.id,
              transcript: text,
              start_time: file.createdTime || null,
              ingest_status: 'ingested',
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'external_recording_id', ignoreDuplicates: true },
          )
          .select('id')
        if (error) throw new Error(`insert failed for ${file.name}: ${error.message}`)
        if (!inserted || inserted.length === 0) return 'duplicate'
        const rowId = inserted[0].id

        // Classify to a project — file name + transcript-derived title cues.
        let projectId: string | null = null
        try {
          projectId = await matchToProject(workspaceId, [], file.name)
          if (projectId) {
            await sb.from('call_transcripts').update({ project_id: projectId }).eq('id', rowId)
          }
        } catch (err: any) {
          console.warn(`[drive-transcripts] classify failed for ${file.name}: ${err.message}`)
        }

        // Embed into RAG (non-fatal — reembed_transcripts can backfill).
        try {
          await embedTranscript({
            id: rowId,
            workspace_id: workspaceId,
            project_id: projectId,
            source: 'drive',
            transcript: text,
            participants: null,
            start_time: file.createdTime || null,
            duration_seconds: null,
            external_recording_id: `drive:${file.id}`,
            external_file_id: file.id,
          })
        } catch (err: any) {
          console.warn(`[drive-transcripts] embed failed for ${file.name}: ${err.message}`)
        }

        console.log(
          `[drive-transcripts] ingested "${file.name}"${projectId ? ` → project ${projectId}` : ' (no project match)'}`,
        )
        return 'ingested'
      })
      if (result === 'ingested') ingested++
      else skipped++
    }

    return { scanned: newFiles.length, ingested, skipped }
  },
)
