# Kit After Effects Render Farm — Implementation Spec

## Overview

Render a single After Effects composition across **every machine in the studio**.
Kit splits the comp's frame range into chunks, each studio PC renders a slice with
Adobe's headless `aerender.exe` into a shared image sequence, and the finished
frames are stitched back into one movie with FFmpeg — which can then flow straight
into the existing **Delivery Pipeline** for broadcast-spec encoding (audio,
loudness, naming).

This feature **reuses the distributed render infrastructure already built for the
Delivery Pipeline** (`DELIVERY-PIPELINE-SPEC.md`): the `render_jobs` /
`render_workers` tables, atomic job claiming, primary/fallback failover,
heartbeats, stale-worker detection, the worker app, and the Slack integration.
The render farm is "a new job type on the farm we already have," not a new system.

```
/kit render <project.aep> | <comp> | <frames> | <fps> [| <delivery profile>]
        │
        ▼
Kit ─── counts online AE-capable workers, splits frames into N chunks
        │   inserts: 1 parent (ae_render) + N chunks (ae_chunk)
        ▼
Render workers ─── AE-capable workers claim chunks (primary first, fallback @30s)
        │   each runs aerender -s <start> -e <end> → shared image sequence
        ▼
Last chunk done ─── one worker wins the finalize lock, enqueues ae_stitch
        │
        ▼
Any worker ─── FFmpeg stitches the sequence → one movie (per delivery profile)
        │
        ▼
Kit → Slack ─── "✅ Render complete: Main Comp.mov"
```

## Existing tools we utilize

| Capability | Source (already built) |
|---|---|
| Headless AE rendering | **Adobe `aerender.exe`** — ships with every After Effects install |
| Free render-only nodes | **After Effects Render Engine** — install on unlimited machines via the Creative Cloud app without consuming a CC seat |
| Job queue + atomic claim | `render_jobs` table + `job-claimer.ts` |
| Primary/fallback failover, heartbeats, stale detection | `render_workers` + `heartbeat.ts` + `resetStaleJobs()` |
| Worker app, Windows install, system tray | `kit-render-worker/` + `install.ps1` |
| Shared file access | Dropbox local sync (`dropbox/file-resolver.ts`) |
| Final encode | FFmpeg runner + delivery profiles |
| Slack commands + fleet status | `/kit` command handler + `delivery` agent |

## Prerequisites (operator setup, not code)

1. **Install the After Effects Render Engine** on each studio PC (Creative Cloud app
   → "Install render engine"). Render-only, no seat consumed.
2. **Consistent footage paths** — every node must resolve the project's linked
   footage identically. Use a Dropbox sync path that's the same shape on every
   machine, or run **Collect Files** before submitting. Path mismatches are the
   classic render-farm failure.
3. **Plugins + fonts** used by the comp must be installed on every render node.
4. **`AERENDER_PATH`** set in each AE machine's worker `.env` (auto-detected by
   `install.ps1`). Machines without AE leave it blank and run transcode/stitch only.
5. *(Recommended)* A shared **Output Module template** (e.g. "Kit PNG Sequence")
   defined in each machine's AE prefs, referenced via `ae_output_module_template`.

## Database (migration `032_ae_render_farm.sql`)

Extends the existing tables — no new tables.

**`render_jobs`** gains a `job_type` discriminator and AE/chunk columns:
- `job_type` — `'transcode' | 'ae_render' | 'ae_chunk' | 'ae_stitch'`
- `parent_job_id`, `chunk_index`, `chunk_count`
- `frame_start`, `frame_end`, `total_frames`, `frame_rate`
- `ae_project_path`, `ae_comp`, `ae_render_settings_template`,
  `ae_output_module_template`, `ae_output_pattern`, `ae_output_dir`
- `delivery_profile_id`, `aerender_command`

**`render_workers`** gains `ae_capable`, `aerender_path`, `ae_version`.

### Job model

| job_type | status at creation | who claims it | what it does |
|---|---|---|---|
| `ae_render` | `processing` | nobody (a tracker) | aggregates chunk progress; holds the finalize lock |
| `ae_chunk` | `pending` | AE-capable workers | `aerender -s/-e` one frame range → image sequence |
| `ae_stitch` | `pending` | any worker | FFmpeg image sequence → movie; marks parent complete |

The `ae_render` parent is never `pending`, so the existing claimer skips it. The
claimer also filters by `job_type` so non-AE workers never grab an `ae_chunk`.

### Finalize lock (race-safe, no Postgres function)

When a worker finishes a chunk it checks whether every sibling chunk is
`complete`. If so it atomically claims the parent's `claimed_by` sentinel
(`'FINALIZED'`) — only one worker's `UPDATE ... WHERE claimed_by IS NULL`
matches — and the winner enqueues the single `ae_stitch` job. Same pattern as the
existing chunk-claim guard.

## Worker app additions (`kit-render-worker/`)

```
src/aerender/
├── command-builder.ts   — build aerender argv for a frame range
├── progress-parser.ts   — parse aerender PROGRESS lines → % within the chunk
├── runner.ts            — spawn aerender, stream progress (stdout)
└── stitch-builder.ts    — build FFmpeg argv: image sequence → movie
src/ae-processor.ts      — processAeChunk + processAeStitch + finalize lock
```

Wired in: `job-processor.ts` routes by `job_type`; `job-claimer.ts` capability-gates
AE chunks; `heartbeat.ts` reports AE capability; `config.ts` reads `AERENDER_PATH`.

### aerender command (per chunk)

```
aerender -project "<aep>" -comp "<comp>" -s <start> -e <end> \
  -RStemplate "Best Settings" [-OMtemplate "<om>"] \
  -output "<dir>\<comp>_[#####].png" \
  -continueOnMissingFootage -sound OFF -mp
```

All chunks share one `-output` pattern and differ only in `-s`/`-e`, so they write
non-overlapping frame-numbered files into the same folder — no collisions.

### Stitch command

```
ffmpeg -framerate <fps> -start_number <first> -i "<dir>\<comp>_%05d.png" \
  -c:v prores_ks -profile:v 2 [-s WxH] [-pix_fmt ...] -r <fps> -y <out.mov>
```

AE's `[#####]` placeholder is converted to FFmpeg's `%05d`. The output is silent
video; send it through the delivery pipeline afterwards for audio/loudness/naming.

## Kit additions

- `src/lib/delivery/frame-planner.ts` — `planChunks()` (even contiguous split) +
  `chooseChunkCount()` (sizes the split to the online AE worker pool, min frames
  per chunk to avoid paying AE launch cost on tiny chunks).
- `src/lib/delivery/ae-storage.ts` — `submitAeRender()` (parent + chunk fan-out),
  `getAeRenderStatus()` (aggregates chunk + stitch progress), `listAeRenders()`,
  `countOnlineAeWorkers()`.
- `delivery` agent actions: `submit_ae_render`, `ae_render_status`,
  `list_ae_renders`.
- `/kit render` Slack command (+ `/kit render status`).

## Usage

```
/kit render /Projects/Acme/Acme.aep | Main Comp | 300 | 59.94 | Microsoft Ignite 2025
/kit render status
```

Kit replies with how many chunks it cut and across how many AE workers, then tracks
progress as the fleet renders.

## Edge cases & gotchas

- **Temporal-dependency effects** (motion blur, frame blending, particle sims with
  "obey shutter") can show seams at chunk boundaries. v1 splits frames cleanly; for
  affected comps, submit with `chunkCount: 1` (whole-comp on one machine) or add a
  small frame overlap in a future iteration.
- **AE launch cost** (~10–30s per chunk) — `chooseChunkCount` keeps chunks ≥ 24
  frames so we don't pay launch overhead on trivially small slices.
- **Frame count must be supplied** — Kit can't probe the `.aep` without AE, so the
  submitter provides the comp's frame count (producers know it).
- **OM template names must exist on every node** — otherwise aerender falls back to
  the comp's render-queue default. Define a shared template for predictable output.
- **No AE workers online** — the render is still submitted; chunks wait `pending`
  until an AE-capable worker registers. Slack warns when this happens.
- **Worker dies mid-chunk** — existing stale-worker detection (60s) resets the chunk
  to `pending` and another AE worker picks it up; the rest of the render is
  unaffected because chunks are independent.
```
