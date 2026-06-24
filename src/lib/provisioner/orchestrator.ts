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

  // ─── PHASE 0: Create the Kit project record (anchor) ────────
  // The DB row is the source of truth everything else hangs off (onboarding
  // resolves projects from here). Create it FIRST and abort on failure, so a
  // bad insert can never leave an orphaned Slack channel or folders with no
  // matching record. Previously this ran after the channel/folders were
  // created and swallowed its error, which produced orphaned projects.
  await onProgress?.('phase_project', `Creating project record for *${projectName}*...`)

  // workspace_id is a required FK; an unresolved workspace is the most common
  // cause of a failed insert. Fail fast with a clear message before touching
  // any external service.
  if (!workspaceId) {
    const msg = 'no workspace could be resolved for this Slack team'
    await onProgress?.('error', `:x: I couldn't create the project — ${msg}. Nothing was created.`)
    throw new Error(`Project record could not be created: ${msg}`)
  }

  let projectId: string
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
    projectId = project.id
    results.projectId = projectId
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Provisioner] Project record insert failed — aborting before any resources are created:', err)
    await onProgress?.(
      'error',
      `:x: I couldn't save the project record, so I stopped before creating any channel or folders — nothing was half-created. Error: ${msg}`,
    )
    throw new Error(`Project record could not be created: ${msg}`)
  }

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

  // ─── PHASE 3: Create Slack channel ──────────────────────────
  // Safe to create now: the project record above is committed, so the channel
  // can never be orphaned.

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
