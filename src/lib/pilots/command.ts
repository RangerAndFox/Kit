/**
 * Pilots — operator command dispatcher (Workstream 6).
 *
 * This is the tested production command path. The Bolt handler is a thin adapter
 * that resolves the gate + actor and calls runPilotCommand; this module parses,
 * authorizes (via the service/diagnostics owners), dispatches, and renders
 * concise, secret-safe operator text. It performs NO Slack/Supabase I/O itself —
 * everything goes through injected PilotDeps — so it is exercised by unit tests
 * and the local smoke harness without a live runtime.
 *
 * Safety: parsing never has side effects; a parse error returns usage only; raw
 * errors are summarized (no stack traces, secrets, or provider payloads leak).
 */

import { parsePilotCommand, PILOT_HELP, type ParsedCommand } from './parser'
import {
  addReference,
  createVisualDevPilot,
  decideGenerationAcceptance,
  finalizeRecommendation,
  isErr,
  recordEvidence,
  recordGeneration,
  recordMaterialMap,
  recordValidation,
  refreshPilotCanvas,
  setVisualLanguage,
  type ActorContext,
  type PilotDeps,
} from './service'
import { authorizePilotAction, isAuthDenied, isFinalizeBlocked } from './transitions'
import {
  buildPilotStatus,
  explainCompleteness,
  runPilotReadiness,
  type Check,
  type PilotStatusView,
} from './diagnostics'
import { formatUsableOutputRate } from './metrics'

export interface CommandInput {
  args: string
  channelId: string
  actor: ActorContext
  gateEnabled: boolean
}

export interface CommandOutput {
  text: string
}

const GATE_DISABLED = '🔒 The Visual Development Pilot capability is not enabled (VISUAL_DEV_PILOT_ENABLED).'

const ICON: Record<Check['status'], string> = {
  ready: '✅',
  blocked: '⛔',
  missing_human_input: '📝',
  unavailable: '⚪',
  error: '❗',
}

function out(text: string): CommandOutput {
  return { text }
}

/**
 * Run one `/kit pilot …` command. `gateEnabled` is resolved by the caller from
 * VISUAL_DEV_PILOT_ENABLED so the dispatcher stays pure of process.env.
 */
export async function runPilotCommand(deps: PilotDeps, input: CommandInput): Promise<CommandOutput> {
  if (!input.gateEnabled) return out(GATE_DISABLED)

  const parsed = parsePilotCommand(input.args)
  if (parsed.status === 'error') {
    return out(`⚠️ ${parsed.message}\nUsage: \`${parsed.usage}\``)
  }
  const cmd = parsed.command
  const { actor, channelId } = input

  try {
    return await dispatch(deps, cmd, actor, channelId)
  } catch (err) {
    // Never leak stack traces / provider payloads to the operator surface.
    console.error('[pilots] command error:', (err as Error)?.message || err)
    return out('❗ Pilot command failed unexpectedly. Check runtime logs.')
  }
}

async function dispatch(
  deps: PilotDeps,
  cmd: ParsedCommand,
  actor: ActorContext,
  channelId: string,
): Promise<CommandOutput> {
  switch (cmd.type) {
    case 'help':
      return out(PILOT_HELP)

    case 'readiness': {
      const r = await runPilotReadiness(deps, { projectId: cmd.projectId ?? undefined, actorWorkspaceId: actor.workspaceId })
      return out(renderReadiness(r.runtime, r.database, r.projectEligibility, r.humanInputs, cmd.projectId))
    }

    case 'status': {
      const snap = await deps.store.loadSnapshot(cmd.pilotId)
      if (!snap) return out('❗ Pilot not found.')
      const auth = authorizePilotAction(snap.pilot, actor)
      if (isAuthDenied(auth)) return out(`⛔ Not authorized (${auth.reason}).`)
      return out(renderStatus(buildPilotStatus(snap)))
    }

    case 'check': {
      const snap = await deps.store.loadSnapshot(cmd.pilotId)
      if (!snap) return out('❗ Pilot not found.')
      const auth = authorizePilotAction(snap.pilot, actor)
      if (isAuthDenied(auth)) return out(`⛔ Not authorized (${auth.reason}).`)
      return out(renderCheck(explainCompleteness(snap)))
    }

    case 'show': {
      const res = await refreshPilotCanvas(deps, { pilotId: cmd.pilotId, channelId, actor })
      if (isErr(res)) return out(renderCanvasFailure(res.reason))
      return out(`📋 Canvas refreshed${res.value.canvasUrl ? `: ${res.value.canvasUrl}` : '.'}`)
    }

    case 'create': {
      const res = await createVisualDevPilot(deps, { projectId: cmd.projectId, title: cmd.title, actor })
      if (isErr(res)) return out(`Couldn't create pilot: ${res.reason}`)
      return out(`✅ Pilot created: \`${res.value.id}\``)
    }

    case 'visual-language': {
      const res = await setVisualLanguage(deps, { pilotId: cmd.pilotId, text: cmd.text, actor })
      return out(isErr(res) ? `Failed: ${res.reason}` : '✅ Visual language recorded.')
    }

    case 'ref': {
      const res = await addReference(deps, {
        pilotId: cmd.pilotId,
        refType: cmd.refType,
        url: cmd.url,
        label: cmd.label,
        actor,
      })
      return out(isErr(res) ? `Failed: ${res.reason}` : `✅ Reference added (${cmd.refType}).`)
    }

    case 'generation': {
      const res = await recordGeneration(deps, {
        pilotId: cmd.pilotId,
        externalRef: cmd.externalRef,
        label: cmd.label,
        kind: 'output',
        actor,
      })
      return out(isErr(res) ? `Failed: ${res.reason}` : `✅ Generation recorded: \`${res.value.id}\` (pending acceptance).`)
    }

    case 'accept':
    case 'reject': {
      const res = await decideGenerationAcceptance(deps, {
        generationId: cmd.generationId,
        accept: cmd.type === 'accept',
        actor,
      })
      return out(isErr(res) ? `Failed: ${res.reason}` : `✅ Output ${cmd.type}ed.`)
    }

    case 'map': {
      const res = await recordMaterialMap(deps, {
        pilotId: cmd.pilotId,
        packageName: cmd.packageName,
        mapType: cmd.mapType,
        purpose: cmd.purpose,
        actor,
      })
      return out(isErr(res) ? `Failed: ${res.reason}` : `✅ Map recorded (${cmd.mapType} in ${cmd.packageName}).`)
    }

    case 'validate': {
      const res = await recordValidation(deps, {
        pilotId: cmd.pilotId,
        tool: cmd.tool,
        passed: cmd.passed,
        evidenceRef: cmd.evidenceRef,
        subject: cmd.subject,
        actor,
      })
      return out(isErr(res) ? `Failed: ${res.reason}` : `✅ ${cmd.tool} validation recorded (${cmd.passed ? 'pass' : 'fail'}).`)
    }

    case 'evidence': {
      const res = await recordEvidence(deps, {
        pilotId: cmd.pilotId,
        category: cmd.category,
        metricKey: cmd.metricKey,
        label: cmd.label,
        valueNumeric: cmd.valueNumeric,
        valueText: cmd.valueText,
        unit: cmd.unit,
        actor,
      })
      return out(isErr(res) ? `Failed: ${res.reason}` : `✅ Evidence recorded (${cmd.category}).`)
    }

    case 'finalize': {
      const res = await finalizeRecommendation(deps, {
        pilotId: cmd.pilotId,
        recommendation: cmd.recommendation,
        rationale: cmd.rationale,
        actor,
      })
      if (isErr(res)) {
        const missing =
          res.finalize && isFinalizeBlocked(res.finalize) && res.finalize.completeness
            ? '\nOutstanding:\n' + res.finalize.completeness.missing.map((m) => `• ${m.detail}`).join('\n')
            : ''
        return out(`Cannot finalize: ${res.reason}${missing}`)
      }
      await refreshPilotCanvas(deps, { pilotId: cmd.pilotId, channelId, actor }).catch(() => {})
      return out(`✅ Pilot finalized: *${cmd.recommendation}*.`)
    }
  }
}

// ─── Renderers (concise, secret-safe) ─────────────────────────────────────────

function renderChecks(title: string, checks: Check[]): string {
  if (!checks.length) return ''
  return `*${title}*\n` + checks.map((c) => `${ICON[c.status]} \`${c.key}\` — ${c.detail}`).join('\n')
}

function renderReadiness(
  runtime: Check[],
  database: Check[],
  project: Check[] | null,
  human: Check[],
  projectId: string | null,
): string {
  const parts = [
    '*Pilot readiness*',
    renderChecks('Runtime', runtime),
    renderChecks('Database', database),
    project ? renderChecks(`Project (${projectId})`, project) : '_No projectId given — pass one to check project eligibility._',
    renderChecks('Human-required inputs', human),
  ].filter(Boolean)
  return parts.join('\n\n')
}

function renderStatus(s: PilotStatusView): string {
  const refs = s.referencesByType
  const g = s.generations
  const c4d = s.validationsByTool.cinema4d
  const rs = s.validationsByTool.redshift
  return [
    `*Pilot* \`${s.pilotId}\` — status: *${s.status}*`,
    `project \`${s.projectId}\` · workspace \`${s.workspaceId ?? '—'}\` · by ${s.createdBy ?? '—'}`,
    `Canvas: ${s.canvas.bound ? `bound (\`${s.canvas.canvasId}\`)` : 'not created'}`,
    `References: pinterest ${refs.pinterest} · figma ${refs.figma_moodboard} · styleframes ${refs.styleframe_direction} · other ${refs.other}`,
    `Generations: ${g.total} total — ${g.accepted} accepted / ${g.rejected} rejected / ${g.pending} pending`,
    `Usable-output rate: ${formatUsableOutputRate(s.metrics.usableOutputRate)}`,
    `Materials: ${s.materialPackages} package(s), ${s.materialMaps} map(s)`,
    `Validation: C4D ${c4d.passed}✓/${c4d.failed}✗ · Redshift ${rs.passed}✓/${rs.failed}✗`,
    `Evidence: measurements ${s.evidenceByCategory.measurement} · assumptions ${s.evidenceByCategory.assumption} · unknowns ${s.evidenceByCategory.unknown} · risks ${s.evidenceByCategory.risk} · decisions ${s.evidenceByCategory.decision}`,
    `Completeness: ${s.completeness.complete ? '✅ complete' : `⛔ ${s.completeness.missing.length} outstanding`}`,
    s.recommendation ? `Recommendation: *${s.recommendation}*` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function renderCheck(x: ReturnType<typeof explainCompleteness>): string {
  const lines: string[] = [`*Completeness check* — ${x.complete ? '✅ ready to finalize' : '⛔ blocked'}`]
  lines.push(
    `Validation: C4D ${x.validations.cinema4dPassed ? '✅ passing' : '⛔ no passing'} · Redshift ${x.validations.redshiftPassed ? '✅ passing' : '⛔ no passing'}`,
  )
  lines.push(`Accepted usable outputs: ${x.acceptedOutputs}/${x.totalOutputs}`)
  const badM = x.measurements.filter((m) => m.state !== 'ok')
  lines.push(
    badM.length
      ? `Measurements needing work: ${badM.map((m) => `${m.key}(${m.state})`).join(', ')}`
      : 'Measurements: ✅ all present & valid',
  )
  lines.push(`Recommendation support: ${x.recommendationSupport ? '✅ present' : '⛔ missing (add a `decision` evidence row)'}`)
  if (!x.complete) {
    for (const grp of x.groups) {
      lines.push(`\n_${grp.category}_`)
      for (const m of grp.missing) lines.push(`• ${m.detail}`)
    }
  }
  return lines.join('\n')
}

function renderCanvasFailure(reason: string): string {
  // A Canvas failure never corrupts pilot state — a retry (`show`) is safe.
  return `⚠️ Canvas refresh failed (${reason}). Pilot data is unaffected; re-run \`/kit pilot show <pilotId>\` to retry.`
}
