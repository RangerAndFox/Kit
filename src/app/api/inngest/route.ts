// @ts-nocheck
import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'
import { provisionProject } from '@/lib/inngest/orchestrator'
import { plaudTranscriptionReady, plaudTranscriptionFailed } from '@/lib/inngest/plaud'
import { preMeetingScan, preMeetingDispatch } from '@/lib/inngest/pre-meeting'
import { deliveryDropboxScan, deliveryJobNotifier, deliveryStaleSweep } from '@/lib/inngest/delivery-crons'
import { studioKnowledgeAutoSummarize } from '@/lib/inngest/studio-knowledge-cron'
import { brainDeadlineSweep, brainScavengerScan, brainConsolidate } from '@/lib/inngest/brain-crons'

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
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    provisionProject,
    plaudTranscriptionReady,
    plaudTranscriptionFailed,
    preMeetingScan,
    preMeetingDispatch,
    deliveryDropboxScan,
    deliveryJobNotifier,
    deliveryStaleSweep,
    studioKnowledgeAutoSummarize,
    brainDeadlineSweep,
    brainScavengerScan,
    brainConsolidate,
    // Add new functions here as agents are built
  ],
})
