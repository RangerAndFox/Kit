# Kit Render Worker

A standalone Node.js worker for the Kit delivery pipeline. Polls Supabase for transcode jobs, runs FFmpeg locally, reports progress back.

## Install

On a Windows studio PC with Node.js 18+ and FFmpeg installed:

```powershell
cd kit-render-worker
.\install.ps1
npm start
```

The installer prompts for:
- Supabase URL + service role key
- Worker role (`primary` or `fallback`) and priority
- Dropbox sync folder path
- FFmpeg binary path (defaults to `ffmpeg` on PATH)

The first heartbeat after `npm start` registers the worker in the `render_workers` Supabase table.

## Run as a service

For unattended operation, recommended options:

- **NSSM** (free, easiest): `nssm install KitRenderWorker "C:\Path\to\node.exe" "src\index.ts"` — point the working directory at this folder.
- **Task Scheduler**: trigger on workstation logon, action `npm start` from this folder, set "Run whether user is logged on or not".

## Architecture

See `DELIVERY-PIPELINE-SPEC.md` at the repo root for the full system architecture.

This worker:
1. Heartbeats to Supabase every 10s (registers itself + reports CPU/memory/disk).
2. Polls `render_jobs` for `status='pending'` rows.
3. Primary workers claim immediately; fallback workers claim only after `FALLBACK_DELAY_SECONDS` (default 30) and only if CPU is below `CPU_THRESHOLD`.
4. Resolves Dropbox paths via `DROPBOX_SYNC_PATH` (must be a local Dropbox sync folder — the worker doesn't talk to Dropbox's HTTP API in v1).
5. Runs FFmpeg (two-pass if loudness normalization is enabled), streams progress back to Supabase.
6. Marks the job `complete` or `failed`.

If a worker goes offline mid-job, Kit's stale-worker sweep (`resetStaleJobs` in `src/lib/delivery/storage.ts`) reassigns the job to another worker after 60s.

## Configuration

All config is via `.env` — see `.env.example`. The installer writes this file.
