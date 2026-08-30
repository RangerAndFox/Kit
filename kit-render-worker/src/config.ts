// @ts-nocheck
import * as os from 'os'
import * as fs from 'fs'
import * as dotenv from 'dotenv'

// Production workers can reuse Kit's existing protected environment file
// without copying service-role credentials into this standalone package.
dotenv.config(process.env.KIT_ENV_FILE ? { path: process.env.KIT_ENV_FILE } : undefined)

function need(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`Missing required env var: ${key}`)
  return v
}

function optional(key: string, def: string): string {
  return process.env[key] || def
}

function num(key: string, def: number): number {
  const v = process.env[key]
  if (!v) return def
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`Env var ${key} is not numeric: ${v}`)
  return n
}

export const config = {
  supabaseUrl: process.env.SUPABASE_URL || need('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseServiceRoleKey: need('SUPABASE_SERVICE_ROLE_KEY'),
  hostname: optional('WORKER_HOSTNAME', os.hostname()),
  displayName: process.env.WORKER_DISPLAY_NAME || null,
  role: (optional('WORKER_ROLE', 'fallback') as 'primary' | 'fallback'),
  priority: num('WORKER_PRIORITY', 10),
  dropboxSyncPath: optional('DROPBOX_SYNC_PATH', ''),
  ffmpegPath: optional('FFMPEG_PATH', 'ffmpeg'),
  ffprobePath: process.env.FFPROBE_PATH || null,

  // After Effects render farm. A worker is AE-capable when AERENDER_PATH points
  // at an existing aerender binary (or AE_CAPABLE=true is forced). Non-capable
  // workers still run transcode + stitch jobs, just not aerender chunks.
  aerenderPath: optional('AERENDER_PATH', ''),
  // AfterFX.exe lives next to aerender.exe and is what we script to read a
  // project's render queue (aerender itself can't dump the queue). Overridable.
  afterfxPath: optional('AFTERFX_PATH', ''),
  aeVersion: process.env.AE_VERSION || null,
  cpuThreshold: num('CPU_THRESHOLD', 50),
  minDiskFreeGb: num('MIN_DISK_FREE_GB', 10),
  heartbeatIntervalMs: num('HEARTBEAT_INTERVAL_MS', 10000),
  pollIntervalMs: num('POLL_INTERVAL_MS', 5000),
  fallbackDelaySeconds: num('FALLBACK_DELAY_SECONDS', 30),
  osVersion: `${os.platform()} ${os.release()}`,
}

// Derive AE capability: explicit AE_CAPABLE override, else true when aerenderPath
// is set and the binary actually exists on disk.
config.aeCapable = process.env.AE_CAPABLE
  ? process.env.AE_CAPABLE === 'true'
  : Boolean(config.aerenderPath && fileExists(config.aerenderPath))

// Derive AfterFX.exe from the aerender path if not explicitly set (same dir).
if (!config.afterfxPath && config.aerenderPath) {
  const dir = config.aerenderPath.replace(/[\\/][^\\/]*$/, '')
  config.afterfxPath = process.platform === 'win32'
    ? `${dir}\\AfterFX.exe`
    : `${dir}/Adobe After Effects 2026.app/Contents/MacOS/After Effects`
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}
