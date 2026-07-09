# Kit Render Worker

A standalone Node.js worker for the Kit render fleet. Polls Supabase for jobs and runs them locally:
- **Transcode jobs** — FFmpeg, per delivery profile (the Delivery Pipeline).
- **After Effects render jobs** — `aerender.exe` frame-range chunks + an FFmpeg stitch (the AE Render Farm).

A worker becomes **AE-capable** when `AERENDER_PATH` points at an `aerender.exe` that exists. AE-capable workers claim aerender frame chunks; every worker (AE or not) can run transcode and stitch jobs.

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
- `aerender.exe` path (auto-detected; leave blank on machines without After Effects)

The first heartbeat after `npm start` registers the worker in the `render_workers` Supabase table.

## Run as a service

For unattended operation, recommended options:

- **NSSM** (free, easiest): `nssm install KitRenderWorker "C:\Path\to\node.exe" "src\index.ts"` — point the working directory at this folder.
- **Task Scheduler**: trigger on workstation logon, action `npm start` from this folder, set "Run whether user is logged on or not".

## Architecture

See `DELIVERY-PIPELINE-SPEC.md` (transcode) and `AE-RENDER-FARM-SPEC.md` (After Effects) at the repo root for the full system architecture.

This worker:
1. Heartbeats to Supabase every 10s (registers itself + reports CPU/memory/disk).
2. Polls `render_jobs` for `status='pending'` rows.
3. Primary workers claim immediately; fallback workers claim only after `FALLBACK_DELAY_SECONDS` (default 30) and only if CPU is below `CPU_THRESHOLD`.
4. Resolves Dropbox paths via `DROPBOX_SYNC_PATH` (must be a local Dropbox sync folder — the worker doesn't talk to Dropbox's HTTP API in v1).
5. Runs the job: FFmpeg for transcode/stitch (two-pass if loudness is enabled), or `aerender` for an AE frame chunk. Streams progress back to Supabase.
6. Marks the job `complete` or `failed`. For AE renders, the worker that finishes the last chunk enqueues the stitch; the stitch worker marks the parent render complete.

If a worker goes offline mid-job, Kit's stale-worker sweep (`resetStaleJobs` in `src/lib/delivery/storage.ts`) reassigns the job to another worker after 60s.

## Configuration

All config is via `.env` — see `.env.example`. The installer writes this file.
