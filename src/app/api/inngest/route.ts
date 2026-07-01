// @ts-nocheck
import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'
import { plaudTranscriptionReady, plaudTranscriptionFailed } from '@/lib/inngest/plaud'
import { preMeetingScan, preMeetingDispatch } from '@/lib/inngest/pre-meeting'
import { deliveryDropboxScan, deliverySpecsScan, deliveryJobNotifier, deliveryStaleSweep } from '@/lib/inngest/delivery-crons'
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
    plaudTranscriptionReady,
    plaudTranscriptionFailed,
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
    // Add new functions here as agents are built
  ],
})
