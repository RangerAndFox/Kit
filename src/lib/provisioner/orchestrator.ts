// @ts-nocheck
import type {
  OrchestratorContext,
  ProvisioningResults,
  ServiceResult,
  ServiceKey,
  ServiceName,
} from './types'
import { provisionDropbox } from './services/dropbox'
import { provisionFrameIo } from './services/frameio'
import { provisionCanva } from './services/canva'
import { provisionFigma } from './services/figma'
import { provisionSlackChannel } from './services/slack-channel'
import { createAdminClient } from '@/lib/supabase/admin'

export type ProgressCallback = (phase: string, message: string) => Promise<void>

function skipped(service: ServiceName): ServiceResult {
  return { service, success: false, error: 'skipped' }
}

function extractResult(
  settled: PromiseSettledResult<ServiceResult>,
  fallback: ServiceName
): ServiceResult {
  if (settled.status === 'fulfilled') return settled.value
  const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
  return { service: fallback, success: false, error: msg }
}

/**
 * Orchestrates full project provisioning.
 *
 * Phase 1 (parallel): Dropbox, Frame.io, Canva, FigJam
 * Phase 2 (sequential): Create Kit project in Supabase
 * Phase 3 (sequential): Create Slack channel
 * Phase 4 (sequential): Update project with all collected URLs
 */
export async function runOrchestrator(
  ctx: OrchestratorContext,
  onProgress?: ProgressCallback
): Promise<ProvisioningResults> {
  const { form, workspaceId, dryRun } = ctx
  const { projectName, clientName, selectedServices } = form
  const sel = new Set<ServiceKey>(selectedServices)
  const results: ProvisioningResults = {}

  const maybeRun = (
    key: ServiceKey,
    fn: () => Promise<ServiceResult>,
    fallback: ServiceName
  ): Promise<ServiceResult> =>
    sel.has(key) ? fn() : Promise.resolve(skipped(fallback))

  // ─── PHASE 1: Parallel provisioning ─────────────────────────

  const active = ['Dropbox', 'Frame.io', 'Canva', 'FigJam']
    .filter((_, i) => {
      const keys: ServiceKey[] = ['dropbox', 'frameio', 'canva', 'figma']
      return sel.has(keys[i])
    })
    .join(', ')

  await onProgress?.(
    'phase1',
    `Provisioning infrastructure for *${projectName}*...\n${active || 'No phase 1 services selected.'}`
  )

  const [dr, fr, ca, fi] = await Promise.allSettled([
    maybeRun('dropbox', () => provisionDropbox(form, dryRun), 'Dropbox'),
    maybeRun('frameio', () => provisionFrameIo(form, dryRun), 'FrameIo'),
    maybeRun('canva', () => provisionCanva(form, dryRun), 'Canva'),
    maybeRun('figma', () => provisionFigma(form, dryRun), 'FigJam'),
  ])

  results.dropbox = extractResult(dr, 'Dropbox')
  results.frameio = extractResult(fr, 'FrameIo')
  results.canva = extractResult(ca, 'Canva')
  results.figma = extractResult(fi, 'FigJam')

  await onProgress?.('phase1_complete', buildPhase1Summary(results, sel))

  // ─── PHASE 2: Create Kit project in Supabase ────────────────

  await onProgress?.('phase2', 'Creating project record...')

  try {
    const db = createAdminClient()
    const { data: project, error } = await db
      .from('projects')
      .insert({
        workspace_id: workspaceId,
        name: projectName,
        client: clientName,
        project_code: form.projectNumber,
        project_type: form.projectType,
        start_date: form.startDate || null,
        target_delivery: form.deadline || null,
        status: 'active',
        external_links: {},
      })
      .select('id')
      .single()

    if (error) throw error
    results.projectId = project.id
  } catch (err) {
    console.error('[Provisioner] Failed to create project:', err)
  }

  // ─── PHASE 3: Create Slack channel ──────────────────────────

  if (sel.has('slack')) {
    await onProgress?.('phase3', 'Setting up Slack project channel...')
    results.slack = await provisionSlackChannel(form, dryRun)
  } else {
    results.slack = skipped('Slack Channel')
  }

  // ─── PHASE 4: Stitch links into project record ──────────────

  if (results.projectId) {
    const links: Record<string, string> = {}
    if (results.dropbox?.url) links.dropbox = results.dropbox.url
    if (results.frameio?.url) links.frameio = results.frameio.url
    if (results.canva?.url) links.canva = results.canva.url
    if (results.figma?.url) links.figjam = results.figma.url
    if (results.slack?.url) links.slack = results.slack.url

    try {
      const db = createAdminClient()
      await db
        .from('projects')
        .update({ external_links: links })
        .eq('id', results.projectId)
    } catch (err) {
      console.error('[Provisioner] Failed to patch links:', err)
    }
  }

  return results
}

function buildPhase1Summary(results: ProvisioningResults, sel: Set<ServiceKey>): string {
  const services: Array<{ label: string; key: ServiceKey; r: ServiceResult | undefined }> = [
    { label: 'Dropbox', key: 'dropbox', r: results.dropbox },
    { label: 'Frame.io', key: 'frameio', r: results.frameio },
    { label: 'Canva', key: 'canva', r: results.canva },
    { label: 'FigJam', key: 'figma', r: results.figma },
  ]

  const lines = services.map(({ label, key, r }) => {
    if (!sel.has(key)) return `  _${label}: skipped_`
    if (!r) return `  ${label}: pending`
    return r.success ? `  *${label}*` : `  ${label}: ${r.error ?? 'failed'}`
  })

  return `*Phase 1 complete:*\n${lines.join('\n')}`
}
