import os from 'node:os'
import path from 'node:path'
import * as dotenv from 'dotenv'

dotenv.config({ path: process.env.KIT_ENV_FILE || path.resolve('../.env.local') })
dotenv.config()

const need = (key: string): string => {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${key}`)
  return value
}
const num = (key: string, fallback: number): number => {
  const value = Number(process.env[key] || fallback)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number.`)
  return value
}

export const config = {
  supabaseUrl: process.env.SUPABASE_URL || need('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseServiceRoleKey: need('SUPABASE_SERVICE_ROLE_KEY'),
  chromePath: process.env.BEHANCE_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  profileDir: path.resolve(process.env.BEHANCE_PROFILE_DIR || './.behance-profile'),
  headless: process.env.BEHANCE_HEADLESS === 'true',
  startUrl: process.env.BEHANCE_START_URL || 'https://www.behance.net/',
  creativeField: process.env.BEHANCE_CREATIVE_FIELD || 'Motion Graphics',
  dropboxSyncPath: path.resolve(need('DROPBOX_SYNC_PATH')),
  workerId: process.env.WORKER_ID || `behance-${os.hostname()}`,
  displayName: process.env.WORKER_DISPLAY_NAME || os.hostname(),
  pollIntervalMs: num('POLL_INTERVAL_MS', 5000),
  heartbeatIntervalMs: num('HEARTBEAT_INTERVAL_MS', 10000),
  jobTimeoutMs: num('JOB_TIMEOUT_MS', 1_200_000),
  elevenLabsStartUrl: process.env.ELEVENLABS_START_URL || 'https://elevenlabs.io/app/studio',
  slackBotToken: process.env.SLACK_BOT_TOKEN?.trim() || null,
}
