// @ts-nocheck
/**
 * Boords Agent — Storyboard Creator
 *
 * Boords does not expose a first-party API. We use a Zapier webhook that
 * receives a JSON payload, hands the data off to Boords (creating a
 * project, storyboard, and frames), then echoes back the Boords URL in
 * the synchronous response.
 *
 * Two flows:
 *   1. Blank storyboard — only projectName is sent. Useful when a producer
 *      wants to start a storyboard from scratch in Boords directly.
 *   2. From-script storyboard — script text is forwarded to the Zap, which
 *      handles AI extraction into frames. Kit does NOT extract scenes
 *      itself; Zapier owns that step.
 *
 * Required env:
 *   BOORDS_ZAPIER_WEBHOOK_URL — full https://hooks.zapier.com/... URL.
 *
 * Expected Zap response shape (sync):
 *   { url: string, id?: string, frames?: number }
 */

import { withRetry } from '@/lib/provisioner/retry'
import type { AgentDefinition, AgentResult } from './types'

interface ZapResponse {
  url?: string
  id?: string
  frames?: number
  error?: string
}

async function postToZap(payload: Record<string, unknown>): Promise<ZapResponse> {
  const webhookUrl = process.env.BOORDS_ZAPIER_WEBHOOK_URL
  if (!webhookUrl) throw new Error('BOORDS_ZAPIER_WEBHOOK_URL not configured')

  return withRetry(async () => {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // Zapier sync responses are bounded to ~30s; give the request a hair more.
      signal: AbortSignal.timeout(35_000),
    })
    if (!r.ok) throw new Error(`Zap ${r.status}: ${await r.text()}`)
    // Zapier may return text/plain even when the body is JSON.
    const text = await r.text()
    try {
      return JSON.parse(text) as ZapResponse
    } catch {
      // If the Zap is fire-and-forget on this end and just returns "ok",
      // surface that as a successful but URL-less response.
      return { url: undefined }
    }
  })
}

// ─── Action Handlers ───────────────────────────────────────

async function createStoryboard(payload: Record<string, unknown>): Promise<AgentResult> {
  const projectName = (payload.projectName as string) || ''
  if (!projectName.trim()) {
    return {
      agent: 'boords',
      action: 'create_storyboard',
      success: false,
      error: 'projectName is required',
    }
  }

  const script = (payload.script as string) || ''
  const hasScript = script.trim().length > 0

  // Whitelist the fields we forward so we don't leak unrelated context
  // from the orchestrator into the Zap payload.
  const body = {
    projectName: projectName.trim(),
    client: payload.client || null,
    script: hasScript ? script : null,
    style: payload.style || null,
    aspectRatio: payload.aspectRatio || null,
    secondsPerFrame: payload.secondsPerFrame || null,
    notes: payload.notes || null,
    deliverableId: payload.deliverableId || null,
    blank: !hasScript,
  }

  try {
    const zap = await postToZap(body)
    if (!zap.url) {
      return {
        agent: 'boords',
        action: 'create_storyboard',
        success: false,
        error: 'Zap accepted the request but did not return a Boords URL',
        data: { sent: body },
      }
    }
    return {
      agent: 'boords',
      action: 'create_storyboard',
      success: true,
      url: zap.url,
      id: zap.id,
      message: hasScript
        ? `Created Boords storyboard "${projectName}"${zap.frames ? ` with ${zap.frames} frames` : ''}`
        : `Created blank Boords storyboard "${projectName}"`,
      data: { frames: zap.frames, blank: !hasScript },
    }
  } catch (err: any) {
    return {
      agent: 'boords',
      action: 'create_storyboard',
      success: false,
      error: err.message,
    }
  }
}

// ─── Agent Definition ──────────────────────────────────────

export const boordsAgent: AgentDefinition = {
  id: 'boords',
  name: 'Boords Agent',
  domain: 'Boords',
  expertise:
    'Storyboard creation in Boords. Ask me to make a new storyboard — either blank, or from a script (text or paste). I always return a direct link to the Boords storyboard. I cannot read existing storyboards or modify frames after creation; I only create new ones.',
  requiredEnvVars: ['BOORDS_ZAPIER_WEBHOOK_URL'],
  capabilities: [
    {
      action: 'create_storyboard',
      description:
        'Create a new Boords storyboard. If a script is provided, Zapier extracts scenes into frames. Without a script, an empty storyboard is created.',
      inputDescription:
        'projectName (required), script (optional plain-text script — omit for blank storyboard), client (optional), style (optional, e.g. "cinematic"|"explainer"), aspectRatio (optional, e.g. "16:9"), secondsPerFrame (optional number), notes (optional)',
      mutates: true,
    },
  ],
  handler: async (action, payload) => {
    switch (action) {
      case 'create_storyboard':
        return createStoryboard(payload)
      default:
        return { agent: 'boords', action, success: false, error: `Unknown action: ${action}` }
    }
  },
}
