import { createClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { config } from './config.js'

export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket as any },
})
