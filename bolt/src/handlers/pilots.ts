// @ts-nocheck
/**
 * Bolt handler for the Pilots capability — `/kit pilot …`.
 *
 * Deliberately THIN: it authenticates the actor (reusing the existing
 * workspace/user resolution), parses a small text grammar, and delegates every
 * decision to the tested pilots service (src/lib/pilots/service.ts). No pilot
 * invariant is enforced here — the service + the DB own them. Authorization is
 * workspace-scoped and never trusts message/button visibility.
 *
 * Gated on VISUAL_DEV_PILOT_ENABLED: when unset/false the whole capability is
 * inert. This handler never touches project creation or Project Control.
 *
 * Grammar (fields after `::` are free text; `::` separates structured parts):
 *   /kit pilot help
 *   /kit pilot create <projectId> :: <title>
 *   /kit pilot visual-language <pilotId> :: <text>
 *   /kit pilot ref <pilotId> <pinterest|figma|styleframe|other> <url|-> :: <label>
 *   /kit pilot generation <pilotId> <externalRef|-> :: <label>
 *   /kit pilot accept <generationId>
 *   /kit pilot reject <generationId>
 *   /kit pilot map <pilotId> <package> <albedo|roughness|normal|height|displacement|…> :: <purpose>
 *   /kit pilot validate <pilotId> <cinema4d|redshift> <pass|fail> <evidenceRef> :: <subject>
 *   /kit pilot evidence <pilotId> <category> [metricKey] :: <label> :: <value> [unit]
 *   /kit pilot finalize <pilotId> <adopt|revise|repeat|discontinue> :: <rationale>
 *   /kit pilot show <pilotId>
 */

import { visualDevPilotEnabled } from '../../../src/lib/pilots/types'
import { defaultPilotDeps } from '../../../src/lib/pilots/defaults'
import {
  createVisualDevPilot,
  addReference,
  setVisualLanguage,
  recordEvidence,
  recordGeneration,
  decideGenerationAcceptance,
  recordMaterialMap,
  recordValidation,
  finalizeRecommendation,
  refreshPilotCanvas,
} from '../../../src/lib/pilots/service'

const REF_TYPE_ALIASES: Record<string, string> = {
  pinterest: 'pinterest',
  figma: 'figma_moodboard',
  figma_moodboard: 'figma_moodboard',
  styleframe: 'styleframe_direction',
  styleframe_direction: 'styleframe_direction',
  other: 'other',
}

function splitFields(rest: string): string[] {
  return rest.split('::').map((s) => s.trim())
}

const HELP = [
  '*Kit Pilots — Visual Development*',
  '`/kit pilot create <projectId> :: <title>`',
  '`/kit pilot visual-language <pilotId> :: <text>`',
  '`/kit pilot ref <pilotId> <pinterest|figma|styleframe|other> <url|-> :: <label>`',
  '`/kit pilot generation <pilotId> <externalRef|-> :: <label>`',
  '`/kit pilot accept|reject <generationId>`',
  '`/kit pilot map <pilotId> <package> <albedo|roughness|normal|height|displacement|…> :: <purpose>`',
  '`/kit pilot validate <pilotId> <cinema4d|redshift> <pass|fail> <evidenceRef> :: <subject>`',
  '`/kit pilot evidence <pilotId> <measurement|observation|judgment|assumption|unknown|risk|decision> [metricKey] :: <label> :: <value> [unit]`',
  '`/kit pilot finalize <pilotId> <adopt|revise|repeat|discontinue> :: <rationale>`',
  '`/kit pilot show <pilotId>`',
].join('\n')

/**
 * Handle `/kit pilot …`. `args` is everything after `pilot`. `ctx` carries the
 * resolved { workspaceId, slackUserId }. The `/kit` command already ack()ed.
 */
export async function handlePilotCommand(opts: {
  args: string
  channelId: string
  ctx: { workspaceId: string; slackUserId: string }
  respond: (msg: { response_type: 'ephemeral'; text: string }) => Promise<unknown>
}): Promise<void> {
  const { args, channelId, ctx, respond } = opts
  const reply = (text: string) => respond({ response_type: 'ephemeral', text })

  if (!visualDevPilotEnabled()) {
    await reply(':lock: The Visual Development Pilot capability is not enabled (VISUAL_DEV_PILOT_ENABLED).')
    return
  }

  const tokens = (args || '').trim().split(/\s+/)
  const sub = (tokens.shift() || 'help').toLowerCase()
  const deps = defaultPilotDeps()
  // Single authenticated actor threaded into every service call; the service
  // derives the authoritative workspace from the pilot/project record.
  const actor = { actingUserId: ctx.slackUserId, workspaceId: ctx.workspaceId }

  try {
    switch (sub) {
      case 'help':
        await reply(HELP)
        return

      case 'create': {
        const projectId = tokens.shift()
        if (!projectId) return void (await reply('Usage: `/kit pilot create <projectId> :: <title>`'))
        const title = splitFields(tokens.join(' '))[0] || null
        const res = await createVisualDevPilot(deps, { projectId, title, actor })
        if (!res.ok) return void (await reply(`Couldn't create pilot: ${res.reason}`))
        await reply(`✅ Pilot created: \`${res.value.id}\``)
        return
      }

      case 'visual-language': {
        const pilotId = tokens.shift()
        const text = splitFields(tokens.join(' '))[0]
        if (!pilotId || !text) return void (await reply('Usage: `/kit pilot visual-language <pilotId> :: <text>`'))
        const res = await setVisualLanguage(deps, { pilotId, text, actor })
        await reply(res.ok ? '✅ Visual language recorded.' : `Failed: ${res.reason}`)
        return
      }

      case 'ref': {
        const pilotId = tokens.shift()
        const kind = (tokens.shift() || '').toLowerCase()
        const urlTok = tokens.shift()
        const label = splitFields(tokens.join(' '))[0] || null
        const refType = REF_TYPE_ALIASES[kind]
        if (!pilotId || !refType) {
          return void (await reply('Usage: `/kit pilot ref <pilotId> <pinterest|figma|styleframe|other> <url|-> :: <label>`'))
        }
        const url = urlTok && urlTok !== '-' ? urlTok : null
        const res = await addReference(deps, { pilotId, refType, url, label, actor })
        await reply(res.ok ? `✅ Reference added (${refType}).` : `Failed: ${res.reason}`)
        return
      }

      case 'generation': {
        const pilotId = tokens.shift()
        const extTok = tokens.shift()
        const label = splitFields(tokens.join(' '))[0] || null
        if (!pilotId) return void (await reply('Usage: `/kit pilot generation <pilotId> <externalRef|-> :: <label>`'))
        const externalRef = extTok && extTok !== '-' ? extTok : null
        const res = await recordGeneration(deps, {
          pilotId,
          externalRef,
          label,
          kind: 'output',
          actor,
        })
        await reply(res.ok ? `✅ Generation recorded: \`${res.value.id}\` (pending acceptance).` : `Failed: ${res.reason}`)
        return
      }

      case 'accept':
      case 'reject': {
        const generationId = tokens.shift()
        if (!generationId) return void (await reply(`Usage: \`/kit pilot ${sub} <generationId>\``))
        const res = await decideGenerationAcceptance(deps, {
          generationId,
          accept: sub === 'accept',
          actor,
        })
        await reply(res.ok ? `✅ Output ${sub}ed.` : `Failed: ${res.reason}`)
        return
      }

      case 'map': {
        const pilotId = tokens.shift()
        const packageName = tokens.shift()
        const mapType = (tokens.shift() || '').toLowerCase()
        const purpose = splitFields(tokens.join(' '))[0]
        if (!pilotId || !packageName || !mapType || !purpose) {
          return void (await reply('Usage: `/kit pilot map <pilotId> <package> <mapType> :: <purpose>`'))
        }
        const res = await recordMaterialMap(deps, {
          pilotId,
          packageName,
          mapType,
          purpose,
          actor,
        })
        await reply(res.ok ? `✅ Map recorded (${mapType} in ${packageName}).` : `Failed: ${res.reason}`)
        return
      }

      case 'validate': {
        const pilotId = tokens.shift()
        const tool = (tokens.shift() || '').toLowerCase()
        const passTok = (tokens.shift() || '').toLowerCase()
        const evidenceRef = tokens.shift()
        const subject = splitFields(tokens.join(' '))[0] || null
        if (!pilotId || !tool || !evidenceRef) {
          return void (await reply('Usage: `/kit pilot validate <pilotId> <cinema4d|redshift> <pass|fail> <evidenceRef> :: <subject>`'))
        }
        const res = await recordValidation(deps, {
          pilotId,
          tool,
          passed: passTok !== 'fail',
          evidenceRef,
          subject,
          actor,
        })
        await reply(res.ok ? `✅ ${tool} validation recorded.` : `Failed: ${res.reason}`)
        return
      }

      case 'evidence': {
        const pilotId = tokens.shift()
        const category = (tokens.shift() || '').toLowerCase()
        // Optional metric key is the next bare token only for measurements.
        let metricKey: string | null = null
        if (category === 'measurement') metricKey = tokens.shift() || null
        const fields = splitFields(tokens.join(' '))
        const label = fields[0] || null
        const rawValue = fields[1] || null
        if (!pilotId || !category) {
          return void (await reply('Usage: `/kit pilot evidence <pilotId> <category> [metricKey] :: <label> :: <value> [unit]`'))
        }
        // A numeric leading token in the value → structured measurement value + unit.
        let valueNumeric: number | null = null
        let valueText: string | null = rawValue
        let unit: string | null = null
        if (category === 'measurement' && rawValue) {
          const m = rawValue.match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/)
          if (m) {
            valueNumeric = parseFloat(m[1])
            unit = m[2].trim() || null
            valueText = null
          }
        }
        const res = await recordEvidence(deps, {
          pilotId,
          category,
          metricKey,
          label,
          valueNumeric,
          valueText,
          unit,
          actor,
        })
        await reply(res.ok ? `✅ Evidence recorded (${category}).` : `Failed: ${res.reason}`)
        return
      }

      case 'finalize': {
        const pilotId = tokens.shift()
        const recommendation = (tokens.shift() || '').toLowerCase()
        const rationale = splitFields(tokens.join(' '))[0] || null
        if (!pilotId || !recommendation) {
          return void (await reply('Usage: `/kit pilot finalize <pilotId> <adopt|revise|repeat|discontinue> :: <rationale>`'))
        }
        const res = await finalizeRecommendation(deps, { pilotId, recommendation, rationale, actor })
        if (!res.ok) {
          const missing = res.finalize && !res.finalize.ok && res.finalize.completeness
            ? '\nOutstanding:\n' + res.finalize.completeness.missing.map((m) => `• ${m.detail}`).join('\n')
            : ''
          return void (await reply(`Cannot finalize: ${res.reason}${missing}`))
        }
        // Refresh the read-only Canvas so the recommendation is projected.
        await refreshPilotCanvas(deps, { pilotId, channelId, actor }).catch(() => {})
        await reply(`✅ Pilot finalized: *${recommendation}*.`)
        return
      }

      case 'show': {
        const pilotId = tokens.shift()
        if (!pilotId) return void (await reply('Usage: `/kit pilot show <pilotId>`'))
        const res = await refreshPilotCanvas(deps, { pilotId, channelId, actor })
        await reply(
          res.ok
            ? `📋 Pilot canvas refreshed${res.value.canvasUrl ? `: ${res.value.canvasUrl}` : '.'}`
            : `Failed: ${res.reason}`,
        )
        return
      }

      default:
        await reply(`Unknown pilot subcommand \`${sub}\`.\n\n${HELP}`)
    }
  } catch (err: any) {
    console.error('[Bolt] /kit pilot error:', err?.message || err)
    await reply(`Pilot command error: ${err?.message || 'unknown'}`)
  }
}
