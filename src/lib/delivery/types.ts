// @ts-nocheck
/**
 * Shared types for the delivery pipeline.
 * Spec: DELIVERY-PIPELINE-SPEC.md
 */

export type ChannelSource =
  | 'L' | 'R'                              // stereo source
  | 'FL' | 'FR' | 'FC' | 'LFE' | 'SL' | 'SR'  // 5.1 source
  | 'silent'
  | string  // also accepts "file:mix.wav:L" style external refs

export interface AudioChannel {
  channel: number   // 1-indexed output channel
  label: string
  source: ChannelSource
}

export interface QCItem {
  text: string
  checked?: boolean
}

export interface DeliveryProfile {
  id: string
  name: string
  description: string | null
  created_by: string

  // Video
  video_codec: string
  video_bitrate: string | null
  resolution_w: number
  resolution_h: number
  frame_rate: string
  frame_rate_mode: 'cfr' | 'vfr'
  scan_mode: 'progressive' | 'interlaced'
  pixel_format: string | null
  color_space: string | null

  // Audio
  audio_codec: string
  audio_sample_rate: number
  audio_bit_depth: number
  audio_bitrate: string | null
  audio_channels: AudioChannel[]

  // Loudness
  lufs_target: number | null
  true_peak_limit: number | null
  loudness_standard: string | null
  lufs_lra: number | null

  // Container / padding
  container: string
  head_pad_seconds: number | null
  tail_pad_seconds: number | null

  // Naming
  naming_template: string | null
  naming_example: string | null

  // QC
  qc_checklist: string[]

  // Notes
  notes: string | null
  pixel_map_url: string | null

  archived: boolean
}

export interface SourceFile {
  path: string
  type: 'video' | 'audio'
  size_bytes: number
  dropbox_id?: string
}

export interface NamingFields {
  [key: string]: string  // {session, speaker, version, event, ...}
}

export interface RenderJobRow {
  id: string
  status: 'pending' | 'claimed' | 'processing' | 'complete' | 'failed' | 'cancelled'
  requested_by: string
  slack_channel: string | null
  slack_thread_ts: string | null
  profile_id: string | null
  profile_snapshot: DeliveryProfile | null
  source_files: SourceFile[]
  naming_fields: NamingFields | null
  output_path: string | null
  output_filename: string | null
  output_size_bytes: number | null
  claimed_by: string | null
  claimed_at: string | null
  processing_started_at: string | null
  completed_at: string | null
  progress_percent: number
  progress_message: string | null
  ffmpeg_command: string | null
  duration_seconds: number | null
  error_message: string | null
  retry_count: number
  max_retries: number
  qc_checklist_status: QCItem[] | null
  created_at: string
  updated_at: string
}

export interface RenderWorkerRow {
  id: string
  hostname: string
  display_name: string | null
  role: 'primary' | 'fallback'
  priority: number
  status: 'online' | 'offline' | 'busy' | 'opted_out'
  last_heartbeat: string | null
  cpu_usage_percent: number | null
  memory_usage_percent: number | null
  disk_free_gb: number | null
  ffmpeg_version: string | null
  os_version: string | null
  current_job_id: string | null
  max_concurrent_jobs: number
  cpu_threshold: number
  dropbox_sync_path: string | null
  ffmpeg_path: string
  opted_out_by: string | null
  opted_out_at: string | null
  opted_out_reason: string | null
  registered_at: string
}

export interface LoudnessMeasurement {
  input_i: number     // measured integrated loudness (LUFS)
  input_tp: number    // measured true peak (dBTP)
  input_lra: number   // measured loudness range
  input_thresh: number
  target_offset: number
}
