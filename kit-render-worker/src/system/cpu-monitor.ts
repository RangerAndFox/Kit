// @ts-nocheck
/**
 * Reads CPU / memory / disk usage. Returns a snapshot used by heartbeat and
 * fallback-worker pre-claim checks.
 *
 * CPU + memory read from stdlib `os`; disk free via `fs.statfs` (Node 18.15+).
 */

import * as os from 'os'
import * as fs from 'fs'
import { config } from '../config'

export interface SystemSnapshot {
  cpuPercent: number
  memoryPercent: number
  diskFreeGb: number
}

/** Aggregate idle + total CPU ticks across all cores. */
function cpuTicks(): { idle: number; total: number } {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) total += t
    idle += c.times.idle
  }
  return { idle, total }
}

/** System-wide CPU utilization % over a sample window (stdlib, cross-platform). */
async function cpuUsagePercent(sampleMs = 500): Promise<number> {
  const a = cpuTicks()
  await new Promise((r) => setTimeout(r, sampleMs))
  const b = cpuTicks()
  const idleDelta = b.idle - a.idle
  const totalDelta = b.total - a.total
  if (totalDelta <= 0) return 0
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
}

export async function readSystemSnapshot(): Promise<SystemSnapshot> {
  let cpu = 0
  try {
    cpu = await cpuUsagePercent(500) // 500ms sample window
  } catch {
    cpu = 0
  }

  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const memoryPercent = totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : 0

  let diskFreeGb = 0
  try {
    const target = config.dropboxSyncPath || os.homedir()
    // Node's fs.statfs is available in Node 18.15+
    if (typeof (fs as any).promises.statfs === 'function') {
      const stat = await (fs as any).promises.statfs(target)
      diskFreeGb = (stat.bavail * stat.bsize) / 1024 / 1024 / 1024
    }
  } catch {
    diskFreeGb = 0
  }

  return { cpuPercent: cpu, memoryPercent, diskFreeGb }
}
