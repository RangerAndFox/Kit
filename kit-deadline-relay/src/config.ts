// @ts-nocheck
import * as os from 'os'
import * as path from 'path'
import * as dotenv from 'dotenv'

dotenv.config()

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

// Locate deadlinecommand: explicit path, else the DEADLINE_PATH env var Deadline
// sets (bin dir), else the default install location.
function resolveDeadlineCommand(): string {
  if (process.env.DEADLINECOMMAND_PATH) return process.env.DEADLINECOMMAND_PATH
  if (process.env.DEADLINE_PATH) return path.join(process.env.DEADLINE_PATH, 'deadlinecommand.exe')
  return 'C:\\Program Files\\Thinkbox\\Deadline10\\bin\\deadlinecommand.exe'
}

export const config = {
  supabaseUrl: need('SUPABASE_URL'),
  supabaseServiceRoleKey: need('SUPABASE_SERVICE_ROLE_KEY'),

  deadlineCommand: resolveDeadlineCommand(),
  // Which Deadline plugin to submit AE jobs to. Keep this ISOLATED from the
  // production C4D setup: use a dedicated AE group (and optionally a custom
  // plugin like 'KitAfterEffects') so nothing here touches C4D pools/groups.
  plugin: optional('DEADLINE_PLUGIN', 'AfterEffects'),
  pool: optional('DEADLINE_POOL', 'none'),
  group: optional('DEADLINE_GROUP', 'none'),
  priority: num('DEADLINE_PRIORITY', 50),
  // The AE version the plugin renders with. AE 2026 = internal version 26.
  aeVersion: optional('AE_VERSION', '26.0'),
  chunkSize: num('DEADLINE_CHUNK_SIZE', 10),

  pathMap: optional('DEADLINE_PATH_MAP', ''),
  afterfxPath: optional('AFTERFX_PATH', ''),
  // aerender for the local audio pass; derived next to AfterFX.exe if unset.
  aerenderPath: optional('AERENDER_PATH', ''),
  // FFmpeg for the assemble step (frames + audio → deliverable).
  ffmpegPath: optional('FFMPEG_PATH', 'ffmpeg'),
  // Keep the PNG frames after a successful assemble (default: delete).
  keepFrames: process.env.AE_KEEP_FRAMES === 'true',

  hostname: optional('RELAY_HOSTNAME', os.hostname()),
  pollIntervalMs: num('POLL_INTERVAL_MS', 10000),
}
