# Kit Delivery Pipeline — Implementation Spec

## Overview

A distributed video transcoding system integrated into Kit. Anyone at the studio drops source files into a Dropbox folder, Kit prompts for delivery specs via Slack, and a pool of render workers (studio PCs) transcode the files using FFmpeg. One designated machine is the primary render box; others auto-failover if it's busy or offline.

**All studio machines are Windows PCs.**

---

## System Architecture

```
Dropbox (/Delivery-Queue/)
    │  new file detected
    ▼
Kit (Railway) ─── polls Dropbox for new files every 30s
    │
    ▼
Slack ─── Kit posts: "New file: intro.mov — pick a delivery profile"
    │     User selects profile or fills custom spec modal
    ▼
Supabase ─── Kit creates row in `render_jobs` table (status: pending)
    │
    ▼
Render Workers ─── poll `render_jobs` for pending jobs
    │  RENDER-01 (primary) claims immediately
    │  EDIT-02, EDIT-03 (fallback) claim after 30s timeout
    ▼
FFmpeg ─── transcode per profile specs
    │
    ▼
Dropbox (/Delivery-Queue/{project}/delivery/)
    │  output file with correct naming
    ▼
Kit → Slack ─── "✓ Done: STUDIO100_BradS_V1_Ignite25.mov — QC checklist below"
```

---

## Database Schema (Supabase)

### Table: `delivery_profiles`

Stores reusable delivery spec profiles (e.g., "Microsoft Ignite 2025", "YouTube 4K", "Broadcast ProRes").

```sql
CREATE TABLE delivery_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                          -- "Microsoft Ignite 2025"
  description TEXT,                            -- "ProRes 422, stereo, -24 LUFS"
  created_by TEXT NOT NULL,                    -- Slack user ID
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  -- Video specs
  video_codec TEXT NOT NULL DEFAULT 'prores_422',  -- prores_422, prores_422_lt, prores_422_hq, prores_4444, h264, dnxhr
  video_bitrate TEXT,                              -- null for ProRes (VBR), "15M" for H.264
  resolution_w INT NOT NULL DEFAULT 1920,
  resolution_h INT NOT NULL DEFAULT 1080,
  frame_rate TEXT NOT NULL DEFAULT '59.94',         -- "23.976", "29.97", "59.94", "25", "50"
  frame_rate_mode TEXT NOT NULL DEFAULT 'cfr',      -- "cfr" (constant) or "vfr" (variable)
  scan_mode TEXT NOT NULL DEFAULT 'progressive',    -- "progressive" or "interlaced"
  pixel_format TEXT DEFAULT 'yuv422p10le',          -- for ProRes
  color_space TEXT,                                 -- "bt709", "bt2020", null = passthrough

  -- Audio specs
  audio_codec TEXT NOT NULL DEFAULT 'pcm_s24le',    -- pcm_s24le, pcm_s16le, aac
  audio_sample_rate INT NOT NULL DEFAULT 48000,
  audio_bit_depth INT NOT NULL DEFAULT 24,
  audio_bitrate TEXT,                               -- null for PCM, "192k" for AAC
  audio_channels JSONB NOT NULL DEFAULT '[
    {"channel": 1, "label": "Stereo Mix Left", "source": "L"},
    {"channel": 2, "label": "Stereo Mix Right", "source": "R"}
  ]'::jsonb,
  -- Channel source options:
  --   "L", "R"           — from stereo source
  --   "FL","FR","FC","LFE","SL","SR" — from 5.1 source
  --   "file:mix.wav:L"   — from separate audio file, left channel
  --   "file:mix.wav:R"   — from separate audio file, right channel
  --   "silent"           — empty/silent channel

  -- Loudness
  lufs_target FLOAT,                               -- -24 for broadcast, null = no normalization
  true_peak_limit FLOAT,                           -- -10 for Ignite, -1 for web
  loudness_standard TEXT DEFAULT 'ITU-R BS.1770-3', -- reference standard
  lufs_lra FLOAT,                                  -- loudness range target, null = auto

  -- Container / output
  container TEXT NOT NULL DEFAULT 'mov',            -- "mov", "mp4", "mxf"
  
  -- Padding
  head_pad_seconds FLOAT DEFAULT 0,                 -- 1-2s for Ignite
  tail_pad_seconds FLOAT DEFAULT 0,                 -- 2-5s for Ignite
  
  -- Naming convention
  naming_template TEXT,                             -- "{session}_{speaker}_V{version}_{event}"
  naming_example TEXT,                              -- "STUDIO100_BradS_V1_Ignite25"
  
  -- QC checklist (items to verify after transcode)
  qc_checklist JSONB DEFAULT '[]'::jsonb,
  -- e.g.: [
  --   "File name includes session code",
  --   "Audio has been through post pass",
  --   "Non-English supertitles burned in",
  --   "Lower thirds match pixel map",
  --   "Color corrected",
  --   "No flash frames or dropped frames",
  --   "Audio in sync throughout"
  -- ]

  -- Notes / reference docs
  notes TEXT,                                       -- freeform notes, links to spec PDFs
  pixel_map_url TEXT,                               -- URL to pixel map image
  
  -- Soft delete
  archived BOOLEAN DEFAULT false
);

CREATE INDEX idx_delivery_profiles_name ON delivery_profiles(name);
CREATE INDEX idx_delivery_profiles_archived ON delivery_profiles(archived) WHERE archived = false;
```

### Table: `render_jobs`

The job queue. Each row is one transcode job.

```sql
CREATE TABLE render_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  -- Status lifecycle: pending → claimed → processing → complete | failed
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'processing', 'complete', 'failed', 'cancelled')),
  
  -- Who requested it
  requested_by TEXT NOT NULL,                      -- Slack user ID
  slack_channel TEXT,                              -- channel where request was made
  slack_thread_ts TEXT,                            -- thread timestamp for updates

  -- Profile
  profile_id UUID REFERENCES delivery_profiles(id),
  profile_snapshot JSONB,                          -- frozen copy of profile at job creation time
                                                   -- (so profile edits don't affect in-flight jobs)
  
  -- Source file(s)
  source_files JSONB NOT NULL,
  -- [{
  --   "path": "/Delivery-Queue/Ignite/intro.mov",   -- Dropbox path
  --   "type": "video",                               -- "video" | "audio"
  --   "size_bytes": 2147483648,
  --   "dropbox_id": "id:abc123"
  -- }]

  -- Naming overrides (filled from Slack modal)
  naming_fields JSONB,
  -- {
  --   "session": "STUDIO100",
  --   "speaker": "BradS",
  --   "version": "1",
  --   "event": "Ignite25"
  -- }

  -- Output
  output_path TEXT,                                -- Dropbox path where output was written
  output_filename TEXT,                            -- final filename with naming convention applied
  output_size_bytes BIGINT,
  
  -- Worker assignment
  claimed_by TEXT,                                 -- worker hostname
  claimed_at TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  
  -- Progress (updated by worker during processing)
  progress_percent INT DEFAULT 0,                  -- 0-100
  progress_message TEXT,                           -- "Encoding video... 45%"
  
  -- FFmpeg details
  ffmpeg_command TEXT,                              -- actual command that was run (for debugging)
  duration_seconds FLOAT,                          -- how long the transcode took
  
  -- Error handling
  error_message TEXT,
  retry_count INT DEFAULT 0,
  max_retries INT DEFAULT 2,
  
  -- QC
  qc_checklist_status JSONB                        -- copy of checklist with checked/unchecked state
);

CREATE INDEX idx_render_jobs_status ON render_jobs(status);
CREATE INDEX idx_render_jobs_pending ON render_jobs(status, created_at) WHERE status = 'pending';
CREATE INDEX idx_render_jobs_worker ON render_jobs(claimed_by) WHERE status IN ('claimed', 'processing');
```

### Table: `render_workers`

Worker registration and heartbeat tracking.

```sql
CREATE TABLE render_workers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname TEXT NOT NULL UNIQUE,                   -- machine hostname (e.g., "RENDER-01")
  display_name TEXT,                               -- friendly name (e.g., "Render Box")
  registered_at TIMESTAMPTZ DEFAULT now(),

  -- Role & priority
  role TEXT NOT NULL DEFAULT 'fallback'
    CHECK (role IN ('primary', 'fallback')),
  priority INT NOT NULL DEFAULT 10,                -- lower = higher priority (primary = 1)
  
  -- Status
  status TEXT NOT NULL DEFAULT 'offline'
    CHECK (status IN ('online', 'offline', 'busy', 'opted_out')),
  last_heartbeat TIMESTAMPTZ,
  
  -- System info (updated with each heartbeat)
  cpu_usage_percent FLOAT,
  memory_usage_percent FLOAT,
  disk_free_gb FLOAT,
  ffmpeg_version TEXT,
  os_version TEXT,
  
  -- Current work
  current_job_id UUID REFERENCES render_jobs(id),
  
  -- Configuration
  max_concurrent_jobs INT DEFAULT 1,               -- usually 1 for quality
  cpu_threshold FLOAT DEFAULT 50.0,                -- won't claim if CPU > this (fallback only)
  dropbox_sync_path TEXT,                          -- local path where Dropbox syncs (e.g., "D:\Dropbox")
  ffmpeg_path TEXT DEFAULT 'ffmpeg',               -- path to ffmpeg binary
  
  -- Opt-out
  opted_out_by TEXT,                               -- Slack user ID who opted out
  opted_out_at TIMESTAMPTZ,
  opted_out_reason TEXT
);

CREATE INDEX idx_render_workers_status ON render_workers(status);
CREATE INDEX idx_render_workers_priority ON render_workers(priority) WHERE status = 'online';
```

---

## Worker Protocol

### Heartbeat

Every worker sends a heartbeat to Supabase every **10 seconds**:

```
UPDATE render_workers
SET last_heartbeat = now(),
    status = 'online',
    cpu_usage_percent = <measured>,
    memory_usage_percent = <measured>,
    disk_free_gb = <measured>,
    current_job_id = <current or null>
WHERE hostname = <this machine>
```

**Stale detection:** Kit (on Railway) runs a periodic check. If a worker's `last_heartbeat` is older than 60 seconds:
1. Set worker `status = 'offline'`
2. If the worker had a claimed/processing job, reset it to `pending` (so another worker picks it up)

### Job Claiming

Workers poll `render_jobs` for claimable work. The claim uses an atomic UPDATE with a WHERE clause to prevent race conditions:

```sql
-- Primary worker (priority 1): claims immediately
UPDATE render_jobs
SET status = 'claimed',
    claimed_by = 'RENDER-01',
    claimed_at = now(),
    updated_at = now()
WHERE id = (
  SELECT id FROM render_jobs
  WHERE status = 'pending'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- Fallback worker (priority 2+): only claims if job has been pending > 30s
UPDATE render_jobs
SET status = 'claimed',
    claimed_by = 'EDIT-02',
    claimed_at = now(),
    updated_at = now()
WHERE id = (
  SELECT id FROM render_jobs
  WHERE status = 'pending'
    AND created_at < now() - INTERVAL '30 seconds'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

**Polling intervals:**
- Primary worker: every **5 seconds**
- Fallback workers: every **15 seconds**

**Pre-claim checks (fallback workers only):**
- CPU usage < configured threshold (default 50%)
- Not opted out
- Has enough disk space (> 10GB free)

### Job Processing Flow

Once a worker claims a job:

1. **Update status** → `processing`, set `processing_started_at`
2. **Notify Kit** → worker writes progress to Supabase, Kit relays to Slack
3. **Resolve source files:**
   - Check if Dropbox has synced the file locally (check `dropbox_sync_path`)
   - If local: use local path (fast)
   - If not synced: download via Dropbox API (slower but works)
4. **Build FFmpeg command** from `profile_snapshot`
5. **Run two-pass loudness analysis** (if `lufs_target` is set)
6. **Run FFmpeg transcode**
7. **Apply naming convention** from `naming_template` + `naming_fields`
8. **Write output** to `/delivery/` subfolder
9. **Update job** → `complete`, set output path, duration, file size
10. **Notify Kit** → Kit posts to Slack with completion message + QC checklist

### Progress Reporting

The worker parses FFmpeg's stderr output to extract progress:

```
frame= 1234 fps=45 q=2.0 size= 102400kB time=00:00:41.23 bitrate=20345.6kbits/s
```

Parse `time=` and compare against source duration to get a percentage. Update `render_jobs.progress_percent` and `progress_message` every 5 seconds. Kit polls this and updates the Slack message.

---

## FFmpeg Command Generation

### Codec Mapping

```typescript
const CODEC_MAP: Record<string, { encoder: string; flags: string[] }> = {
  // ProRes family (Windows uses prores_ks software encoder)
  'prores_422_proxy': { encoder: 'prores_ks', flags: ['-profile:v', '0'] },
  'prores_422_lt':    { encoder: 'prores_ks', flags: ['-profile:v', '1'] },
  'prores_422':       { encoder: 'prores_ks', flags: ['-profile:v', '2'] },
  'prores_422_hq':    { encoder: 'prores_ks', flags: ['-profile:v', '3'] },
  'prores_4444':      { encoder: 'prores_ks', flags: ['-profile:v', '4', '-pix_fmt', 'yuva444p10le'] },

  // H.264
  'h264':             { encoder: 'libx264',   flags: ['-preset', 'slow', '-crf', '18'] },
  'h264_broadcast':   { encoder: 'libx264',   flags: ['-preset', 'slow', '-b:v', '15M', '-maxrate', '15M', '-bufsize', '30M'] },

  // DNxHR
  'dnxhr_lb':         { encoder: 'dnxhd',     flags: ['-profile:v', 'dnxhr_lb'] },
  'dnxhr_sq':         { encoder: 'dnxhd',     flags: ['-profile:v', 'dnxhr_sq'] },
  'dnxhr_hq':         { encoder: 'dnxhd',     flags: ['-profile:v', 'dnxhr_hq'] },
  'dnxhr_hqx':        { encoder: 'dnxhd',     flags: ['-profile:v', 'dnxhr_hqx'] },
  'dnxhr_444':        { encoder: 'dnxhd',     flags: ['-profile:v', 'dnxhr_444'] },
};
```

### Audio Codec Mapping

```typescript
const AUDIO_CODEC_MAP: Record<string, { encoder: string; flags: string[] }> = {
  'pcm_s16le':  { encoder: 'pcm_s16le',  flags: ['-ar', '48000'] },
  'pcm_s24le':  { encoder: 'pcm_s24le',  flags: ['-ar', '48000'] },
  'aac':        { encoder: 'aac',         flags: ['-ar', '48000', '-b:a', '192k'] },
};
```

### Two-Pass Loudness Normalization

When `lufs_target` is set, FFmpeg must do a two-pass encode:

```bash
# Pass 1: Analyze loudness (no output file)
ffmpeg -i input.mov -af loudnorm=I=-24:TP=-10:LRA=11:print_format=json -f null NUL

# Parse JSON output to get measured values:
# {
#   "input_i": "-18.5",
#   "input_tp": "-3.2",
#   "input_lra": "8.1",
#   "input_thresh": "-29.0",
#   "target_offset": "-5.5"
# }

# Pass 2: Apply correction using measured values
ffmpeg -i input.mov \
  -c:v prores_ks -profile:v 2 \
  -c:a pcm_s24le -ar 48000 \
  -af loudnorm=I=-24:TP=-10:LRA=11:measured_I=-18.5:measured_TP=-3.2:measured_LRA=8.1:measured_thresh=-29.0:offset=-5.5:linear=true \
  -r 59.94 \
  output.mov
```

**Important:** The `linear=true` flag ensures the normalization uses linear scaling rather than dynamic compression, which preserves the original dynamic range while hitting the target loudness. This is critical for broadcast delivery.

### Channel Mapping Examples

**2-channel stereo (Ignite spec):**
```bash
# Source is stereo → output stereo on channels 1-2
-af "pan=stereo|c0=c0|c1=c1"

# Source is 5.1 → downmix to stereo on channels 1-2
-af "pan=stereo|c0=0.5*c0+0.35*c2+0.25*c4|c1=0.5*c1+0.35*c2+0.25*c5"
```

**4-channel (separate stereo mix + M&E on channels 3-4):**
```bash
# Two separate files: mix.wav (stereo) + me.wav (stereo) → 4-channel output
ffmpeg -i video.mov -i mix.wav -i me.wav \
  -filter_complex "[1:a][2:a]amerge=inputs=2[aout]" \
  -map 0:v -map "[aout]" \
  -c:v prores_ks -profile:v 2 \
  -c:a pcm_s24le -ar 48000 -ac 4 \
  output.mov

# Single 5.1 source → 4-channel (L, R, Ls, Rs — dropping center and LFE)
-af "pan=4.0|c0=c0|c1=c1|c2=c4|c3=c5"
```

**6-channel 5.1 surround:**
```bash
# Passthrough 5.1
-af "pan=5.1|c0=c0|c1=c1|c2=c2|c3=c3|c4=c4|c5=c5"
-channel_layout 5.1
```

### Complete Example: Microsoft Ignite 2025

```bash
# Pass 1: Loudness analysis
ffmpeg -i "D:\Dropbox\Delivery-Queue\Ignite\intro.mov" \
  -af loudnorm=I=-24:TP=-10:LRA=11:print_format=json \
  -f null NUL 2>&1

# Pass 2: Full transcode
ffmpeg -i "D:\Dropbox\Delivery-Queue\Ignite\intro.mov" \
  -c:v prores_ks \
  -profile:v 2 \
  -s 1920x1080 \
  -r 59.94 \
  -pix_fmt yuv422p10le \
  -c:a pcm_s24le \
  -ar 48000 \
  -af "loudnorm=I=-24:TP=-10:LRA=11:measured_I=-18.5:measured_TP=-3.2:measured_LRA=8.1:measured_thresh=-29.0:offset=-5.5:linear=true,pan=stereo|c0=c0|c1=c1" \
  -movflags +faststart \
  "D:\Dropbox\Delivery-Queue\Ignite\delivery\STUDIO100_BradS_V1_Ignite25.mov"
```

---

## Kit Integration (Railway)

### New Agent: `src/lib/inngest/agents/delivery.ts`

Add a `delivery` agent to the existing agent registry with these capabilities:

```typescript
capabilities: [
  {
    action: 'create_profile',
    description: 'Create a new delivery spec profile',
    inputDescription: 'name, codec, resolution, frame rate, audio specs, loudness, naming, QC checklist',
    mutates: true,
  },
  {
    action: 'list_profiles',
    description: 'List all delivery profiles',
    mutates: false,
  },
  {
    action: 'get_profile',
    description: 'Get details of a delivery profile',
    inputDescription: 'profileId or name',
    mutates: false,
  },
  {
    action: 'submit_job',
    description: 'Submit a transcode job to the render queue',
    inputDescription: 'source file path(s), profile ID, naming fields',
    mutates: true,
  },
  {
    action: 'job_status',
    description: 'Check status of a transcode job',
    inputDescription: 'jobId',
    mutates: false,
  },
  {
    action: 'list_workers',
    description: 'List all render workers and their status',
    mutates: false,
  },
  {
    action: 'worker_status',
    description: 'Get detailed status of a specific worker',
    inputDescription: 'hostname',
    mutates: false,
  },
]
```

### Dropbox Watcher

Add a polling loop in Kit (Railway) that checks Dropbox for new files:

```typescript
// Poll every 30 seconds
// Check /Delivery-Queue/ for files not already tracked in render_jobs
// When new file found:
//   1. Post to Slack with file info
//   2. Attach "Select Profile" button that opens the spec modal
//   3. Optionally auto-submit if a default profile is set for the folder
```

**File detection logic:**
- Use Dropbox `list_folder` API with cursor for efficient delta checking
- Track seen files in Supabase to avoid duplicate notifications
- Ignore files in `/delivery/` subfolders (those are outputs)
- Ignore temporary files (`.tmp`, `.part`, `~$*`)
- Wait for file to be fully uploaded (check `is_downloadable` flag or file size stability over 2 polls)

### Slack Modals

#### Profile Selection Modal (`kit_delivery_select_profile`)

Triggered when a file is detected or user runs `/kit deliver`:

```
┌─────────────────────────────────────────┐
│  Delivery Transcode                     │
│                                         │
│  Source file:                           │
│  📎 intro.mov (2.1 GB, 1920x1080)      │
│                                         │
│  Delivery Profile:                      │
│  ┌──────────────────────────────────┐   │
│  │ Microsoft Ignite 2025          ▾ │   │
│  └──────────────────────────────────┘   │
│  ProRes 422 • 1080p59.94 • PCM stereo   │
│  -24 LUFS / -10 dBTP                    │
│                                         │
│  ─── Naming Fields ───                  │
│                                         │
│  Session Code:  [STUDIO100        ]     │
│  Speaker:       [BradS            ]     │
│  Version:       [1                ]     │
│                                         │
│  Preview: STUDIO100_BradS_V1_Ignite25   │
│                                         │
│  ─── Additional Audio (optional) ───    │
│                                         │
│  Separate audio file:                   │
│  ┌──────────────────────────────────┐   │
│  │ None                           ▾ │   │
│  └──────────────────────────────────┘   │
│                                         │
│              [Cancel]  [Submit Job]     │
└─────────────────────────────────────────┘
```

#### Profile Creation Modal (`kit_delivery_create_profile`)

Triggered by `/kit profiles create`:

```
┌──────────────────────────────────────────┐
│  Create Delivery Profile                 │
│                                          │
│  Profile Name:    [                    ] │
│  Description:     [                    ] │
│                                          │
│  ─── Video ───                           │
│  Codec:           [ProRes 422        ▾ ] │
│  Resolution:      [1920] x [1080]        │
│  Frame Rate:      [59.94            ▾ ]  │
│  Scan:            [Progressive      ▾ ]  │
│                                          │
│  ─── Audio ───                           │
│  Codec:           [PCM 24-bit       ▾ ]  │
│  Sample Rate:     [48000            ▾ ]  │
│  Channels:        [2 — Stereo       ▾ ]  │
│  Channel Layout:                         │
│    Ch 1: [Stereo Mix Left           ▾ ]  │
│    Ch 2: [Stereo Mix Right          ▾ ]  │
│                                          │
│  ─── Loudness ───                        │
│  Target LUFS:     [-24              ]    │
│  True Peak Limit: [-10              ]    │
│  Standard:        [ITU-R BS.1770-3  ▾ ]  │
│                                          │
│  ─── Output ───                          │
│  Container:       [.mov             ▾ ]  │
│  Naming Template: [{session}_{speaker}]  │
│  Head Pad (sec):  [1                ]    │
│  Tail Pad (sec):  [3                ]    │
│                                          │
│  ─── QC Checklist ───                    │
│  (one item per line)                     │
│  ┌──────────────────────────────────┐    │
│  │ File name includes session code │    │
│  │ Audio post pass completed       │    │
│  │ Lower thirds match pixel map    │    │
│  │ Color corrected                 │    │
│  │ No flash frames                 │    │
│  └──────────────────────────────────┘    │
│                                          │
│               [Cancel]  [Save Profile]   │
└──────────────────────────────────────────┘
```

### Slack Commands

```
/kit deliver              — opens profile selection modal (can attach a Dropbox path)
/kit deliver status       — shows all active/recent jobs with progress
/kit profiles             — list all delivery profiles
/kit profiles create      — opens profile creation modal
/kit profiles edit <name> — edit an existing profile
/kit workers              — show worker pool status (online/offline/busy, current jobs)
/kit workers opt-out <hostname>  — temporarily remove a worker from the pool
/kit workers opt-in <hostname>   — re-add a worker to the pool
```

### Slack Notifications

**Job submitted:**
```
📦 Transcode job submitted
File: intro.mov (2.1 GB)
Profile: Microsoft Ignite 2025
Output: STUDIO100_BradS_V1_Ignite25.mov
Queued — waiting for render worker...
```

**Job claimed:**
```
🔧 RENDER-01 picked up the job
Starting transcode...
```

**Progress updates (edit the same message):**
```
🔧 RENDER-01 — Transcoding intro.mov
Profile: Microsoft Ignite 2025
Progress: ████████░░░░░░░░ 52% (ETA: 4m 12s)
Pass 2/2: Encoding video + audio normalization
```

**Job complete:**
```
✅ Transcode complete!
Output: STUDIO100_BradS_V1_Ignite25.mov (3.8 GB)
Location: /Delivery-Queue/Ignite/delivery/
Duration: 8m 34s | Worker: RENDER-01

📋 QC Checklist — verify before submission:
☐ File name includes session code
☐ Audio post pass completed
☐ Non-English supertitles burned in
☐ Lower thirds match pixel map
☐ Color corrected
☐ No flash frames or dropped frames
☐ Audio in sync throughout
```

**Job failed:**
```
❌ Transcode failed
File: intro.mov
Error: FFmpeg exited with code 1 — "Avi header not found"
Worker: RENDER-01 | Attempt 1/3
[Retry]  [Cancel]  [View Logs]
```

**Failover notification:**
```
⚠️ RENDER-01 didn't respond — job reassigned
EDIT-02 is picking up the transcode for intro.mov
```

---

## Render Worker App

### Overview

A standalone Node.js application that runs on studio PCs as a Windows service. Lightweight — its only job is to poll Supabase for jobs, run FFmpeg, and report status.

### Project Structure

```
kit-render-worker/
├── src/
│   ├── index.ts              — entry point, starts worker loop
│   ├── config.ts             — loads config from .env or config file
│   ├── heartbeat.ts          — sends heartbeat to Supabase every 10s
│   ├── job-claimer.ts        — polls for and claims pending jobs
│   ├── job-processor.ts      — orchestrates the transcode pipeline
│   ├── ffmpeg/
│   │   ├── command-builder.ts  — builds FFmpeg command from profile
│   │   ├── loudness.ts         — two-pass loudness analysis + normalization
│   │   ├── channel-mapper.ts   — builds channel mapping filters
│   │   ├── progress-parser.ts  — parses FFmpeg stderr for progress %
│   │   └── runner.ts           — spawns FFmpeg process, streams output
│   ├── dropbox/
│   │   └── file-resolver.ts    — resolves Dropbox paths to local paths
│   ├── system/
│   │   ├── cpu-monitor.ts      — reads CPU/memory/disk usage
│   │   └── service.ts          — Windows service registration (node-windows)
│   └── tray/
│       └── tray-app.ts         — system tray icon (electron-tray or similar)
├── install.ps1               — PowerShell installer script
├── package.json
├── tsconfig.json
└── .env.example
```

### Configuration

```env
# Supabase connection
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Worker identity
WORKER_HOSTNAME=RENDER-01          # auto-detected if not set
WORKER_ROLE=primary                # "primary" or "fallback"
WORKER_PRIORITY=1                  # lower = higher priority

# Dropbox
DROPBOX_SYNC_PATH=D:\Dropbox       # local Dropbox sync folder path

# FFmpeg
FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg   # path to ffmpeg.exe

# Thresholds
CPU_THRESHOLD=50                   # fallback workers won't claim if CPU > this %
MIN_DISK_FREE_GB=10                # won't claim if disk < this
```

### Installer Script (`install.ps1`)

One-click setup for any studio PC:

```powershell
# 1. Check if FFmpeg is installed, install if not
# 2. Prompt for worker role (primary/fallback) and priority
# 3. Prompt for Dropbox sync path
# 4. Write .env config file
# 5. Register worker in Supabase
# 6. Install as Windows service (auto-start on boot)
# 7. Optionally install system tray app
```

### System Tray App

Minimal tray icon showing worker status:

- **Green icon** — online, idle
- **Blue icon** — processing a job (tooltip shows progress)
- **Yellow icon** — opted out
- **Red icon** — error / offline

Right-click menu:
- Current status + job info
- Opt out / Opt in
- View recent jobs
- Open logs folder
- Quit (stops service)

---

## Implementation Order

Build in this order — each phase is independently useful:

### Phase 1: Database + Profiles (Supabase)
1. Create the three tables (`delivery_profiles`, `render_jobs`, `render_workers`)
2. Seed with the Microsoft Ignite 2025 profile using the specs from this doc
3. Add RLS policies (service role for Kit + workers)

### Phase 2: Kit Delivery Agent (Railway)
4. Create `src/lib/inngest/agents/delivery.ts` agent
5. Add Slack modals for profile creation and job submission
6. Add `/kit deliver`, `/kit profiles`, `/kit workers` commands
7. Wire into existing command handler + agent registry

### Phase 3: FFmpeg Command Builder (shared module)
8. Build the command builder as a standalone module (can be tested independently)
9. Implement two-pass loudness normalization
10. Implement channel mapping logic
11. Test with sample files locally

### Phase 4: Render Worker App
12. Scaffold the worker app
13. Implement heartbeat + Supabase connection
14. Implement job claiming with priority logic
15. Implement job processor (FFmpeg runner + progress parsing)
16. Implement Dropbox file resolution (local sync path → file path)
17. Test end-to-end on one machine

### Phase 5: Distributed Workers
18. Build the installer script
19. Implement auto-failover logic (30s timeout + stale worker detection)
20. Install on render box as primary
21. Install on 1-2 editor workstations as fallback
22. Test failover scenarios

### Phase 6: Polish
23. Build system tray app
24. Add Dropbox watcher (auto-detect new files)
25. Slack progress updates (edit message with progress bar)
26. QC checklist in Slack (interactive checkboxes)
27. Job retry logic

---

## Edge Cases & Error Handling

- **Large files:** ProRes 1080p60 can be 5-10+ GB. Ensure Dropbox has synced fully before starting transcode. Check file size stability over 2 poll cycles.
- **Disk space:** Check available disk space before starting. ProRes output can be larger than input. Require 2x source file size free.
- **FFmpeg crash:** Capture exit code and stderr. If exit code != 0, mark job as failed, clean up partial output, post error to Slack.
- **Worker crash mid-job:** Stale heartbeat detection (60s) triggers job reset to `pending`. Another worker picks it up.
- **Duplicate claims:** The `FOR UPDATE SKIP LOCKED` SQL pattern prevents two workers from claiming the same job.
- **Profile edited mid-job:** Jobs store a `profile_snapshot` at creation time, so profile edits don't affect in-flight jobs.
- **Source file deleted:** Check file exists before starting. If gone, fail immediately with clear error.
- **Network interruption:** Workers operate on local files (via Dropbox sync). Supabase connection loss pauses heartbeat/progress but doesn't interrupt FFmpeg. Worker retries Supabase updates on reconnect.
- **Multiple source files (video + separate audio):** The `source_files` array supports multiple files. FFmpeg's `-i` flag handles multiple inputs. Channel mapper builds the appropriate `amerge` or `amix` filter.

---

## Security Notes

- Workers authenticate to Supabase using the service role key. In a future iteration, consider per-worker API keys stored in the worker table.
- The worker app never receives credentials for Dropbox, Slack, or other services — it only talks to Supabase and reads/writes local files.
- FFmpeg commands are logged to the job record for debugging, but source file paths may contain client names. Ensure Supabase RLS restricts access appropriately.

---

## Testing Plan

1. **Unit tests:** FFmpeg command builder — given a profile, assert correct flags
2. **Unit tests:** Channel mapper — given channel config JSON, assert correct `-af` filter
3. **Unit tests:** Loudness parser — given FFmpeg JSON output, assert correct measured values
4. **Integration test:** Submit a job via Supabase, verify worker claims and processes it
5. **End-to-end test:** Drop a test file in Dropbox → Kit prompts in Slack → select Ignite profile → verify output specs with `ffprobe`
6. **Failover test:** Stop primary worker mid-job → verify fallback picks it up
7. **Loudness validation:** Transcode a test file, measure output with `ffprobe` → confirm LUFS/peak match target
