// @ts-nocheck
/**
 * Delivery agent — exposes the delivery pipeline as a Kit Agent (MCP-discoverable).
 *
 * Capabilities map to operations on delivery_profiles and render_jobs.
 * Spec: DELIVERY-PIPELINE-SPEC.md "New Agent: src/lib/inngest/agents/delivery.ts"
 */

import type { AgentDefinition, AgentResult } from './types'
import {
  listProfiles,
  getProfile,
  createProfile,
  submitJob,
  getJob,
  listRecentJobs,
  listWorkers,
  getWorker,
  setWorkerOptOut,
  setWorkerOptIn,
} from '../../delivery/storage'

async function handle(action: string, payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    switch (action) {
      case 'list_profiles': {
        const profiles = await listProfiles(Boolean(payload.includeArchived))
        return { agent: 'delivery', action, success: true, data: profiles }
      }
      case 'get_profile': {
        const idOrName = String(payload.profileId || payload.name || '')
        if (!idOrName) return { agent: 'delivery', action, success: false, error: 'profileId or name required' }
        const profile = await getProfile(idOrName)
        if (!profile) return { agent: 'delivery', action, success: false, error: 'profile not found' }
        return { agent: 'delivery', action, success: true, data: profile }
      }
      case 'create_profile': {
        const created = await createProfile(payload as any)
        return { agent: 'delivery', action, success: true, data: created }
      }
      case 'submit_job': {
        const job = await submitJob({
          profileId: String(payload.profileId),
          sourceFiles: payload.sourceFiles as any,
          namingFields: (payload.namingFields as any) || {},
          requestedBy: String(payload.requestedBy || 'system'),
          slackChannel: payload.slackChannel as string,
          slackThreadTs: payload.slackThreadTs as string,
        })
        return { agent: 'delivery', action, success: true, data: job }
      }
      case 'job_status': {
        const job = await getJob(String(payload.jobId))
        if (!job) return { agent: 'delivery', action, success: false, error: 'job not found' }
        return { agent: 'delivery', action, success: true, data: job }
      }
      case 'list_jobs': {
        const jobs = await listRecentJobs(Number(payload.limit) || 25)
        return { agent: 'delivery', action, success: true, data: jobs }
      }
      case 'list_workers': {
        const workers = await listWorkers()
        return { agent: 'delivery', action, success: true, data: workers }
      }
      case 'worker_status': {
        const w = await getWorker(String(payload.hostname))
        if (!w) return { agent: 'delivery', action, success: false, error: 'worker not found' }
        return { agent: 'delivery', action, success: true, data: w }
      }
      case 'worker_opt_out': {
        await setWorkerOptOut(
          String(payload.hostname),
          String(payload.optedOutBy || 'system'),
          String(payload.reason || ''),
        )
        return { agent: 'delivery', action, success: true }
      }
      case 'worker_opt_in': {
        await setWorkerOptIn(String(payload.hostname))
        return { agent: 'delivery', action, success: true }
      }
      default:
        return { agent: 'delivery', action, success: false, error: `unknown action: ${action}` }
    }
  } catch (err: any) {
    return { agent: 'delivery', action, success: false, error: err.message || String(err) }
  }
}

export const deliveryAgent: AgentDefinition = {
  id: 'delivery',
  name: 'Delivery',
  domain: 'video transcoding & delivery',
  expertise:
    'Manages delivery spec profiles, queues transcode jobs to the render worker pool, and tracks worker fleet status.',
  requiredEnvVars: [], // uses Supabase service role which Kit already has
  capabilities: [
    { action: 'list_profiles', description: 'List all delivery profiles', mutates: false },
    { action: 'get_profile', description: 'Get details of a delivery profile by id or name', mutates: false },
    { action: 'create_profile', description: 'Create a new delivery spec profile', mutates: true },
    { action: 'submit_job', description: 'Submit a transcode job to the render queue', mutates: true },
    { action: 'job_status', description: 'Check status of a transcode job', mutates: false },
    { action: 'list_jobs', description: 'List recent transcode jobs', mutates: false },
    { action: 'list_workers', description: 'List render workers and their status', mutates: false },
    { action: 'worker_status', description: 'Get detailed status of a specific worker', mutates: false },
    { action: 'worker_opt_out', description: 'Remove a worker from the pool', mutates: true },
    { action: 'worker_opt_in', description: 'Re-add a worker to the pool', mutates: true },
  ],
  handler: handle,
}
