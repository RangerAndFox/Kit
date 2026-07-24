/**
 * Pilots — pure command parser (Workstream 5).
 *
 * No I/O, no side effects. Turns the raw `/kit pilot …` argument string into a
 * typed, validated ParsedCommand or a stable error+usage. Parsing NEVER throws
 * and NEVER performs an action, so a malformed command can't accidentally
 * execute. Valid enum values come from the authoritative type arrays in types.ts.
 *
 * Grammar: `<sub> <positional…> :: <field> :: <field> …`. The head (before the
 * first `::`) holds the subcommand + positional tokens; `::` separates free-text
 * fields (which may themselves contain spaces).
 *
 * The result uses a STRING discriminant (`status`) — not a boolean — so callers
 * narrow correctly under both the root strict tsconfig and Bolt's non-strict one.
 */

import {
  EVIDENCE_CATEGORIES,
  MATERIAL_MAP_TYPES,
  PILOT_RECOMMENDATIONS,
  REFERENCE_TYPES,
  VALIDATION_TOOLS,
  type EvidenceCategory,
  type MaterialMapType,
  type PilotRecommendation,
  type ReferenceType,
  type ValidationTool,
} from './types'

export type ParsedCommand =
  | { type: 'help' }
  | { type: 'readiness'; projectId: string | null }
  | { type: 'check'; pilotId: string }
  | { type: 'status'; pilotId: string }
  | { type: 'show'; pilotId: string }
  | { type: 'create'; projectId: string; title: string | null }
  | { type: 'visual-language'; pilotId: string; text: string }
  | { type: 'ref'; pilotId: string; refType: ReferenceType; url: string | null; label: string | null }
  | { type: 'generation'; pilotId: string; externalRef: string | null; label: string | null }
  | { type: 'accept'; generationId: string }
  | { type: 'reject'; generationId: string }
  | { type: 'map'; pilotId: string; packageName: string; mapType: MaterialMapType; purpose: string }
  | {
      type: 'validate'
      pilotId: string
      tool: ValidationTool
      passed: boolean
      evidenceRef: string
      subject: string | null
    }
  | {
      type: 'evidence'
      pilotId: string
      category: EvidenceCategory
      metricKey: string | null
      label: string | null
      valueNumeric: number | null
      valueText: string | null
      unit: string | null
    }
  | { type: 'finalize'; pilotId: string; recommendation: PilotRecommendation; rationale: string | null }

export type ParseResult =
  | { status: 'ok'; command: ParsedCommand }
  | { status: 'error'; message: string; usage: string }

const REF_ALIASES: Record<string, ReferenceType> = {
  pinterest: 'pinterest',
  figma: 'figma_moodboard',
  figma_moodboard: 'figma_moodboard',
  moodboard: 'figma_moodboard',
  styleframe: 'styleframe_direction',
  styleframe_direction: 'styleframe_direction',
  direction: 'styleframe_direction',
  other: 'other',
}

const USAGE: Record<string, string> = {
  readiness: '/kit pilot readiness [projectId]',
  check: '/kit pilot check <pilotId>',
  status: '/kit pilot status <pilotId>',
  create: '/kit pilot create <projectId> :: <title>',
  'visual-language': '/kit pilot visual-language <pilotId> :: <text>',
  ref: `/kit pilot ref <pilotId> <${REFERENCE_TYPES.join('|')}> <url|-> :: <label>`,
  generation: '/kit pilot generation <pilotId> <externalRef|-> :: <label>',
  accept: '/kit pilot accept <generationId>',
  reject: '/kit pilot reject <generationId>',
  map: `/kit pilot map <pilotId> <package> <${MATERIAL_MAP_TYPES.join('|')}> :: <purpose>`,
  validate: `/kit pilot validate <pilotId> <${VALIDATION_TOOLS.join('|')}> <pass|fail> <evidenceRef> :: <subject>`,
  evidence: `/kit pilot evidence <pilotId> <${EVIDENCE_CATEGORIES.join('|')}> [metricKey] :: <label> :: <value> [unit]`,
  finalize: `/kit pilot finalize <pilotId> <${PILOT_RECOMMENDATIONS.join('|')}> :: <rationale>`,
}

export const PILOT_HELP: string = [
  '*Kit Pilots — Visual Development*',
  '_Read-only:_',
  `• \`${USAGE.readiness}\` — runtime/schema/project readiness`,
  `• \`${USAGE.status}\` — full pilot status + metrics`,
  `• \`${USAGE.check}\` — why finalization is blocked`,
  '_Lifecycle:_',
  `• \`${USAGE.create}\``,
  `• \`${USAGE['visual-language']}\``,
  `• \`${USAGE.ref}\``,
  `• \`${USAGE.generation}\``,
  '• `/kit pilot accept|reject <generationId>`',
  `• \`${USAGE.map}\``,
  `• \`${USAGE.validate}\``,
  `• \`${USAGE.evidence}\``,
  `• \`${USAGE.finalize}\``,
  '• `/kit pilot show <pilotId>` — refresh the read-only Canvas',
].join('\n')

function ok(command: ParsedCommand): ParseResult {
  return { status: 'ok', command }
}
function err(sub: string, message: string): ParseResult {
  return { status: 'error', message, usage: USAGE[sub] ?? PILOT_HELP }
}

/** Parse a measurement value token into a numeric+unit or plain text. */
export function parseMeasurementValue(raw: string | null): {
  valueNumeric: number | null
  valueText: string | null
  unit: string | null
} {
  if (!raw) return { valueNumeric: null, valueText: null, unit: null }
  const m = raw.match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/)
  if (m) return { valueNumeric: parseFloat(m[1]), valueText: null, unit: m[2].trim() || null }
  return { valueNumeric: null, valueText: raw, unit: null }
}

export function parsePilotCommand(args: string): ParseResult {
  const trimmed = (args || '').trim()
  if (!trimmed) return ok({ type: 'help' })

  const [headRaw, ...fieldParts] = trimmed.split('::')
  const fields = fieldParts.map((s) => s.trim())
  const field = (i: number): string | null => (fields[i] && fields[i].length > 0 ? fields[i] : null)
  const head = headRaw.trim().split(/\s+/).filter(Boolean)
  const sub = (head.shift() || 'help').toLowerCase()

  switch (sub) {
    case 'help':
      return ok({ type: 'help' })

    case 'readiness':
      return ok({ type: 'readiness', projectId: head[0] || null })

    case 'check':
      return head[0] ? ok({ type: 'check', pilotId: head[0] }) : err('check', 'pilotId is required')

    case 'status':
      return head[0] ? ok({ type: 'status', pilotId: head[0] }) : err('status', 'pilotId is required')

    case 'show':
      // `show` refreshes the read-only Canvas (an action, distinct from status).
      return head[0] ? ok({ type: 'show', pilotId: head[0] }) : err('show', 'pilotId is required')

    case 'create': {
      if (!head[0]) return err('create', 'projectId is required')
      return ok({ type: 'create', projectId: head[0], title: field(0) })
    }

    case 'visual-language': {
      if (!head[0]) return err('visual-language', 'pilotId is required')
      const text = field(0)
      if (!text) return err('visual-language', 'a non-empty text after `::` is required')
      return ok({ type: 'visual-language', pilotId: head[0], text })
    }

    case 'ref': {
      if (!head[0]) return err('ref', 'pilotId is required')
      const refType = REF_ALIASES[(head[1] || '').toLowerCase()]
      if (!refType) return err('ref', `ref type must be one of: ${REFERENCE_TYPES.join(', ')}`)
      const urlTok = head[2]
      const url = urlTok && urlTok !== '-' ? urlTok : null
      if ((refType === 'pinterest' || refType === 'figma_moodboard') && !url) {
        return err('ref', `${refType} requires a URL`)
      }
      return ok({ type: 'ref', pilotId: head[0], refType, url, label: field(0) })
    }

    case 'generation': {
      if (!head[0]) return err('generation', 'pilotId is required')
      const extTok = head[1]
      return ok({
        type: 'generation',
        pilotId: head[0],
        externalRef: extTok && extTok !== '-' ? extTok : null,
        label: field(0),
      })
    }

    case 'accept':
      return head[0] ? ok({ type: 'accept', generationId: head[0] }) : err('accept', 'generationId is required')
    case 'reject':
      return head[0] ? ok({ type: 'reject', generationId: head[0] }) : err('reject', 'generationId is required')

    case 'map': {
      if (!head[0]) return err('map', 'pilotId is required')
      if (!head[1]) return err('map', 'package name is required')
      const mapType = (head[2] || '').toLowerCase() as MaterialMapType
      if (!(MATERIAL_MAP_TYPES as readonly string[]).includes(mapType)) {
        return err('map', `map type must be one of: ${MATERIAL_MAP_TYPES.join(', ')}`)
      }
      const purpose = field(0)
      if (!purpose) return err('map', 'a non-empty purpose after `::` is required')
      return ok({ type: 'map', pilotId: head[0], packageName: head[1], mapType, purpose })
    }

    case 'validate': {
      if (!head[0]) return err('validate', 'pilotId is required')
      const tool = (head[1] || '').toLowerCase() as ValidationTool
      if (!(VALIDATION_TOOLS as readonly string[]).includes(tool)) {
        return err('validate', `tool must be one of: ${VALIDATION_TOOLS.join(', ')}`)
      }
      const passTok = (head[2] || '').toLowerCase()
      if (passTok !== 'pass' && passTok !== 'fail') return err('validate', 'result must be `pass` or `fail`')
      const evidenceRef = head[3]
      if (!evidenceRef) return err('validate', 'evidenceRef is required')
      return ok({ type: 'validate', pilotId: head[0], tool, passed: passTok === 'pass', evidenceRef, subject: field(0) })
    }

    case 'evidence': {
      if (!head[0]) return err('evidence', 'pilotId is required')
      const category = (head[1] || '').toLowerCase() as EvidenceCategory
      if (!(EVIDENCE_CATEGORIES as readonly string[]).includes(category)) {
        return err('evidence', `category must be one of: ${EVIDENCE_CATEGORIES.join(', ')}`)
      }
      const metricKey = category === 'measurement' ? head[2] || null : null
      if (category === 'measurement' && !metricKey) {
        return err('evidence', 'a measurement requires a metricKey (e.g. time, cost)')
      }
      const label = field(0)
      const { valueNumeric, valueText, unit } =
        category === 'measurement'
          ? parseMeasurementValue(field(1))
          : { valueNumeric: null, valueText: field(1), unit: null }
      if (category === 'measurement' && valueNumeric === null && !valueText) {
        return err('evidence', 'a measurement requires a value after the second `::`')
      }
      return ok({ type: 'evidence', pilotId: head[0], category, metricKey, label, valueNumeric, valueText, unit })
    }

    case 'finalize': {
      if (!head[0]) return err('finalize', 'pilotId is required')
      const recommendation = (head[1] || '').toLowerCase() as PilotRecommendation
      if (!(PILOT_RECOMMENDATIONS as readonly string[]).includes(recommendation)) {
        return err('finalize', `recommendation must be one of: ${PILOT_RECOMMENDATIONS.join(', ')}`)
      }
      return ok({ type: 'finalize', pilotId: head[0], recommendation, rationale: field(0) })
    }

    default:
      return { status: 'error', message: `unknown subcommand \`${sub}\``, usage: PILOT_HELP }
  }
}
