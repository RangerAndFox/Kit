// @ts-nocheck
import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'
import { preMeetingScan, preMeetingDispatch } from '@/lib/inngest/pre-meeting'
import { deliveryDropboxScan, deliverySpecsScan, deliveryJobNotifier, deliveryStaleSweep } from '@/lib/inngest/delivery-crons'
import { studioKnowledgeAutoSummarize } from '@/lib/inngest/studio-knowledge-cron'
import { brainDeadlineSweep, brainScavengerScan, brainConsolidate } from '@/lib/inngest/brain-crons'
import { driveTranscriptScan } from '@/lib/inngest/drive-transcripts'
import { healthWatchdog } from '@/lib/inngest/health-cron'
import { projectControlSync } from '@/lib/inngest/project-control-sync'

/**
 * Inngest API route.
 *
 * Inngest's serve() adapter handles:
 *   - Function registration (POST /api/inngest)
 *   - Step execution callbacks
 *   - Health checks
 *
 * All Kit Inngest functions are registered here.
 */

// Own the serverless execution limit for this route rather than inheriting an
// unstated Vercel default (which can be as low as 10-15s). The delivery specs
// scan bounds each tick to a ~30s elapsed budget; 60s leaves conservative
// headroom for a page or folder re-list already in flight. Matches the
// explicit-ownership convention used by the app's other heavy routes
// (mcp, slack/events = 60).
export const maxDuration = 60

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
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
    // Add new functions here as agents are built
  ],
})
