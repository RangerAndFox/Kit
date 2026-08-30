// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { config } from './config'

export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  // Supabase initializes its realtime client even though this worker polls.
  // Node 20 has no native WebSocket, so provide the local transport explicitly.
  realtime: { transport: WebSocket as any },
})
