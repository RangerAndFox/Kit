// @ts-nocheck
/**
 * Heartbeat — upserts a render_workers row every HEARTBEAT_INTERVAL_MS.
 *
 * Also reports system snapshot (CPU/mem/disk). Called on startup to register
 * the worker, then on a setInterval until shutdown.
 */

import { supabase } from './supabase'
import { config } from './config'
import { readSystemSnapshot } from './system/cpu-monitor'

let _currentJobId: string | null = null

export function setCurrentJob(jobId: string | null): void {
  _currentJobId = jobId
}

export function getCurrentJob(): string | null {
  return _currentJobId
}

export async function sendHeartbeat(): Promise<void> {
  const sys = await readSystemSnapshot()
  const status = _currentJobId ? 'busy' : 'online'

  // Use upsert so the first heartbeat registers the worker.
  await supabase.from('render_workers').upsert(
    {
      hostname: config.hostname,
      display_name: config.displayName || config.hostname,
      role: config.role,
      priority: config.priority,
      status,
      last_heartbeat: new Date().toISOString(),
      cpu_usage_percent: sys.cpuPercent,
      memory_usage_percent: sys.memoryPercent,
      disk_free_gb: sys.diskFreeGb,
      current_job_id: _currentJobId,
      max_concurrent_jobs: 1,
      cpu_threshold: config.cpuThreshold,
      dropbox_sync_path: config.dropboxSyncPath || null,
      ffmpeg_path: config.ffmpegPath,
      os_version: config.osVersion,
    },
    { onConflict: 'hostname' },
  )
}

export function startHeartbeat(): NodeJS.Timeout {
  // Fire one immediately then every HEARTBEAT_INTERVAL_MS.
  sendHeartbeat().catch((err) => console.error('[heartbeat] initial failed:', err.message))
  return setInterval(() => {
    sendHeartbeat().catch((err) => console.error('[heartbeat] failed:', err.message))
  }, config.heartbeatIntervalMs)
}
