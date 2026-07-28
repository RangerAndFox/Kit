// @ts-nocheck
import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'
import { preMeetingScan, preMeetingDispatch } from '@/lib/inngest/pre-meeting'
import { deliveryDropboxScan, deliverySpecsScan, deliveryJobNotifier, deliveryStaleSweep } from '@/lib/inngest/delivery-crons'
import { studioKnowledgeAutoSummarize } from '@/lib/inngest/studio-knowledge-cron'
import { brainDeadlineSweep, brainScavengerScan, brainConsolidate } from '@/lib/inngest/brain-crons'
import { driveTranscriptScan } from '@/lib/inngest/drive-transcripts'
import { healthWatchdog } from '@/lib/inngest/health-cron'
import { projectControlSync, projectControlSyncOnEdit } from '@/lib/inngest/project-control-sync'
import { selectRegisteredFunctions } from '@/lib/inngest/registration'

/**
 * Inngest API route.
 *
 * Inngest's serve() adapter handles:
 *   - Function registration (POST /api/inngest)
 *   - Step execution callbacks
 *   - Health checks
 *
 * All Kit Inngest functions are registered here.
 *
 * WHICH deployments may register them is decided by selectRegisteredFunctions
 * (see `@/lib/inngest/registration`): a Vercel Preview deployment registers
 * ZERO functions unless it sets KIT_INNGEST_ALLOW_PREVIEW=true, so preview code
 * can never be scheduled against the production Inngest environment. Production
 * and local development are unaffected.
 */

// Own the serverless execution limit for this route rather than inheriting an
// unstated Vercel default (which can be as low as 10-15s). The delivery specs
// scan bounds each tick to a ~30s elapsed budget; 60s leaves conservative
// headroom for a page or folder re-list already in flight. Matches the
// explicit-ownership convention used by the app's other heavy routes
// (mcp, slack/events = 60).
export const maxDuration = 60

export const inngestFunctions = [
  preMeetingScan,
  preMeetingDispatch,
  deliveryDropboxScan,
  deliverySpecsScan,
  deliveryJobNotifier,
  deliveryStaleSweep,
  studioKnowledgeAutoSummarize,
  brainDeadlineSweep,
  brainScavengerScan,
  brainConsolidate,
  driveTranscriptScan,
  healthWatchdog,
  projectControlSync,
  // Event-driven Project Control refresh — same canonical core as the cron.
  // Inside the guarded list, so a Vercel Preview deployment registers it as
  // ZERO functions too (never scheduled against the production environment).
  projectControlSyncOnEdit,
  // Add new functions here as agents are built
]

// The EXACT list serve() registers: the one canonical list run through the
// fail-closed #119 boundary. Exported (alongside the canonical list) purely so
// tests can assert the wiring structurally — never a second/raw list.
export const registeredFunctions = selectRegisteredFunctions(inngestFunctions)

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: registeredFunctions,
})
