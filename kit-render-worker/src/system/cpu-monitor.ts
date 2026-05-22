// @ts-nocheck
/**
 * Reads CPU / memory / disk usage. Returns a snapshot used by heartbeat and
 * fallback-worker pre-claim checks.
 *
 * Uses `node-os-utils` which provides cross-platform CPU + memory readings.
 * Disk free reads via `os` + `fs.statfs` (Node 18.15+).
 */

import * as os from 'os'
import * as fs from 'fs'
// @ts-ignore — node-os-utils has no types
import osu from 'node-os-utils'
import { config } from '../config'

export interface SystemSnapshot {
  cpuPercent: number
  memoryPercent: number
  diskFreeGb: number
}

export async function readSystemSnapshot(): Promise<SystemSnapshot> {
  let cpu = 0
  try {
    cpu = await osu.cpu.usage(500) // 500ms sample window
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
