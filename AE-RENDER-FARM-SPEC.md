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

**Render-queue-driven.** The user just gives Kit the `.aep` — no comp, frames,
fps, or profile. Kit reads the project's **own After Effects render queue** and
renders every queued item with the render settings + output module the artist
already set. Because Kit (on Railway) can't open a `.aep`, an AE-capable worker
performs an `ae_inspect` step first that scripts After Effects to dump the queue,
then fans the queued items out into chunks.

```
/kit render  ──▶  modal: just the .aep Dropbox path
        │
        ▼
Kit ─── inserts 1 parent (ae_render) + 1 ae_inspect job
        ▼
AE worker ─── claims ae_inspect → scripts AfterFX.exe to dump the render queue
        │   for each QUEUED item: frame-split if it's an image sequence,
        │   render whole if it's a single movie → inserts ae_chunk rows
        ▼
AE workers ─── claim chunks (primary first, fallback @30s); each runs
        │   aerender -rqindex <n> -s <start> -e <end> -output <shared Dropbox dir>
        ▼
Last chunk done ─── one worker wins the finalize lock → parent complete
        │   (or, if a delivery profile was attached, enqueues an ae_stitch)
        ▼
Kit → Slack ─── "✅ Render complete"
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
| `ae_render` | `processing` | nobody (a tracker) | aggregates progress; holds the finalize lock |
| `ae_inspect` | `pending` | AE-capable workers | scripts AfterFX to dump the render queue, then inserts the `ae_chunk` rows |
| `ae_chunk` | `pending` | AE-capable workers | `aerender -rqindex/-s/-e` one frame range → shared output |
| `ae_stitch` | `pending` | any worker | FFmpeg image sequence → movie (only when a delivery profile is attached) |

### Render-queue inspection

`ae_inspect` runs `AfterFX.exe -noui -r inspect.jsx` (the full binary lives next
to `aerender.exe`; aerender alone can't enumerate the queue). The generated
ExtendScript opens the project and, for every **QUEUED** render-queue item,
reports: AE render-queue index, comp name, fps, frame range (from the item's time
span), the output module's filename, and whether it's an image sequence (filename
carries a `[#####]` placeholder) or a single movie. The worker then:

- **image-sequence item** → frame-split across the online AE workers (`ae_chunk`
  rows with `ae_rqindex` set);
- **single-movie item** → one whole-render `ae_chunk` (movies can't be split).

### Honoring the project's settings vs. output path

Chunks render with `aerender -rqindex <n>`, so each item's **render settings and
output module (format) are exactly what the artist queued**. The one thing the
farm overrides is the *destination*: a project's baked-in output path is absolute
and machine-specific, so it can't resolve across nodes. The farm redirects
`-output` to a shared folder next to the project (`<projectDir>/render/<comp>/`)
using the queue item's own filename, so every machine's frames collect in one
Dropbox location.

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
├── command-builder.ts   — build aerender argv (rqindex or explicit-comp mode)
├── progress-parser.ts   — parse aerender PROGRESS lines → % within the chunk
├── runner.ts            — spawn aerender, stream progress (stdout)
├── inspect-script.ts    — generate the ExtendScript that dumps the render queue
├── inspect-runner.ts    — run AfterFX headless, parse the queue JSON
└── stitch-builder.ts    — build FFmpeg argv: image sequence → movie
src/ae-processor.ts      — processAeInspect + processAeChunk + processAeStitch + finalize lock
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
- `src/lib/delivery/ae-storage.ts` — `submitAeRenderFromProject()` (parent +
  `ae_inspect`, the modal path), `submitAeRender()` (explicit comp + chunk
  fan-out), `getAeRenderStatus()` (aggregates progress), `listAeRenders()`,
  `countOnlineAeWorkers()`.
- `delivery` agent actions: `render_project`, `submit_ae_render`,
  `ae_render_status`, `list_ae_renders`.
- `/kit render` Slack command → opens the render modal (`render-modal.ts`,
  handled in `submit-handler.ts`); `/kit render status` lists jobs.

## Usage

`/kit render` opens a modal whose only field is the Dropbox path to the `.aep`
(prefilled if you type one after the command). Kit reads the project's render
queue and renders the queued items — no other input. `/kit render status` lists
recent renders with per-render chunk progress.

The `delivery` agent also exposes this conversationally:
- `render_project` — render a `.aep` from its own queue (the modal's path).
- `submit_ae_render` — explicit single-comp render (comp + frame count), for
  programmatic callers that already know the range.

> **Prerequisite:** queue your comps in After Effects' Render Queue (set their
> output module / render settings) and save the project before submitting. Kit
> renders exactly what's queued.

## Backend: Deadline (for studios already running a Deadline farm)

Kit's render backend is pluggable (`RENDER_BACKEND` env, default `kit-worker`).
Set `RENDER_BACKEND=deadline` and `/kit render` hands work to an existing
Thinkbox/AWS **Deadline** farm instead of Kit's own worker fleet — no per-box
worker install, because Deadline's Workers are already on every node.

```
/kit render (modal)  ──▶  Kit inserts an ae_render parent (render_backend='deadline')
        ▼
kit-deadline-relay ─── ONE studio box; claims the parent
        │   reads the render queue (AfterFX -r inspect.jsx), then per queued comp:
        │   deadlinecommand -SubmitJob  (image seq → ChunkSize split; movie → whole)
        ▼
Deadline farm ─── its Workers render the comps (AfterEffects plugin → aerender)
        ▼
relay polls deadlinecommand -GetJob ─── rolls status → Supabase → /kit render status
```

- **No new tables.** Migration `034` adds `render_backend` + a `deadline_jobs`
  jsonb (the per-comp JobIDs) to `render_jobs`.
- **The relay is one small Node service** (`kit-deadline-relay/`) on a box that
  has `deadlinecommand`, After Effects (to read the queue), and share access.
- **Settings honored** the same way: submission sets `Comp`, `Version`, and an
  `Output` redirected to `<projectDir>/render/<comp>/`; Deadline frame-splits via
  the job's `Frames` + `ChunkSize`.
- **SAN-native paths**: projects live on the production SAN
  (`\\thewire\production\...`), same as C4D. `/kit render` takes that path (or a
  `Z:\...` drive path); the relay passes it straight to Deadline as `SceneFile`
  and writes output to `<projectDir>\render\<comp>\`. `DEADLINE_PATH_MAP` only
  normalizes drive letters to UNC (`Z:=>\\thewire\production`) so headless Workers
  resolve it. No Dropbox in the Deadline path.

### Prepare + assemble (sequence-first pipeline)

Deadline frame-splits only image sequences, but artists queue their comps with
the real deliverable OM (ProRes 422, H.264, ...). The relay therefore renders
sequence-first and assembles afterwards:

1. **Prepare** (AfterFX script on the relay box): per QUEUED item, capture the
   original OM (filename + `getSettings()` blob for codec sniffing), override
   the OM to a **PNG sequence**, duplicate the item with a **WAV** OM when the
   comp has audio, save `<name>__kitfarm.aep` next to the original (the artist's
   file is never modified; `aerender -comp` renders the *first* queued instance,
   so the audio duplicate is invisible to the farm job).
2. **Deadline** renders the farm copy's PNG sequence to
   `render\<comp>\frames\`, ChunkSize-split across `kit_ae`.
3. **Audio pass** renders locally on the relay (`aerender -rqindex <dup>`) →
   `render\<comp>\<comp>_audio.wav`.
4. **Assemble** (FFmpeg on the relay, when the Deadline job completes): frames
   at the comp's fps → the sniffed original format (ProRes 422/LT/HQ/Proxy/4444
   via `prores_ks`, H.264 via `libx264`; default ProRes 422 .mov), audio muxed
   with `-shortest`, written to `render\<comp>\<original filename>`. Frames are
   deleted on success (`AE_KEEP_FRAMES=true` to keep).
5. If the OM can't be overridden to a sequence, the comp falls back to a
   whole-movie render in the artist's own OM (no split, no assemble).

**Isolation from a production C4D farm (hard requirement).** This integration is
strictly additive and must never alter an existing C4D Deadline setup:
- The relay is **submit-only** — it runs no admin/config commands, so it cannot
  change pools, groups, plugins, or repository settings.
- AE jobs target a **dedicated AE group** (`DEADLINE_GROUP`, e.g. `kit_ae`) on
  nodes you designate; creating/assigning a group doesn't affect `c4d_render`.
- The submit **plugin is configurable** (`DEADLINE_PLUGIN`) so AE 2026 support can
  live in a **custom plugin overlay** (`custom/plugins/KitAfterEffects`) that never
  touches the stock AfterEffects or C4D plugins.

**AE 2026 note.** The stock `AfterEffects.py` builds the executable config key
dynamically (`RenderExecutable<major>_0` from the submitted `Version`), so v26 is
not blocked — it just needs a `RenderExecutable26_0` entry (the 2022 `.param` only
defines up to `22_0`). Add it via a `KitAfterEffects` custom overlay
(`custom/plugins/`, zero-touch to stock/C4D), set `DEADLINE_PLUGIN=KitAfterEffects`
and `AE_VERSION=26.0`. Every AE render node needs After Effects 2026 installed.

## Watch folder: 08_AE/04_RenderFarm (auto-submit)

Every project gets an `08_AE/04_RenderFarm/` folder. Any `.aep` that lands there
(as soon as Dropbox syncs it) is auto-submitted to the render farm — no Slack
command needed. Output goes to the standard `<projectDir>\render\<comp>\`.

Implementation (extends the existing `/production` Dropbox webhook watcher in
`bolt/src/watchers/dropbox.ts`):

- Match `/production/<year>/<safeName>/08_AE/04_RenderFarm/<file>.aep` on the
  webhook cursor delta → translate to the SAN path
  (`AE_FARM_UNC_ROOT`, default `\\thewire\production`) → `submitAeRenderFromProject`.
- **Dedupe on Dropbox `id@rev`** (via the `seen_dropbox_files` ledger, keys
  prefixed `aefarm:`): each saved revision renders exactly once. Re-saving the
  file re-renders it; webhook replays don't. Conflicted-copy files are skipped.
- Posts ":clapper: Render farm — <file> dropped" to the project's Slack channel
  when one is linked.
- **Completion notifier** (`src/lib/delivery/ae-notify.ts`, every-minute cron in
  the Bolt app): announces complete/failed in the render's Slack channel,
  idempotent via `slack_notified_status` (migration 020's columns).

Requirement: the render queue must be saved *in* the dropped project — the farm
renders the queued items, so an .aep with an empty queue fails with a clear
message in the channel.

## Spec follow-up: chaining into the delivery pipeline

The render-complete Slack notice carries an **Add delivery specs** button. The
flow reuses the existing spec-intake machinery end-to-end:

1. Button click → Kit opens a spec-intake thread on the notice
   (`delivery_spec_intake` row whose sources are the assembled render(s),
   UNC→Dropbox-translated) and asks for the spec.
2. Operator replies in-thread with the spec — text, PDF, or screenshot. Extra
   files beyond the render (e.g. 4-channel audio splits) join via
   `audio: /production/.../splits.wav` lines (bare `/production/...wav` paths are
   also picked up).
3. The extractor identifies codec/resolution/fps/audio layout/loudness, flags
   anything it had to default, saves the spec as a delivery profile, and submits
   a transcode job with the render (+ extra audio) as sources.
4. The transcode worker delivers **next to the source video**
   (`render/<comp>/`, via `delivery_spec_intake.output_dir` →
   `render_jobs.ae_output_dir`, migration 035) rather than the default
   `/delivery` subfolder.

Prerequisite: at least one `kit-render-worker` running with `DROPBOX_SYNC_PATH`
covering `/production` (the transcode side of the farm is Dropbox-resolved).

## Edge cases & gotchas

- **Temporal-dependency effects** (motion blur, frame blending, particle sims with
  "obey shutter") can show seams at chunk boundaries. v1 splits frames cleanly; for
  affected comps, submit with `chunkCount: 1` (whole-comp on one machine) or add a
  small frame overlap in a future iteration.
- **AE launch cost** (~10–30s per chunk) — `chooseChunkCount` keeps chunks ≥ 24
  frames so we don't pay launch overhead on trivially small slices.
- **Scripting must be allowed on render nodes** — `ae_inspect` runs `AfterFX.exe`
  with `-r script.jsx`. If a node blocks app scripting, inspection fails with a
  clear error; another AE node can pick it up.
- **Queue the comps first** — only items with status **QUEUED** in the project's
  render queue are rendered. Nothing queued → the render fails with a clear message.
- **Output path is redirected** — the farm honors the queue item's format but writes
  to `<projectDir>/render/<comp>/` in Dropbox (a project's absolute output path
  can't resolve across machines).
- **No AE workers online** — the render is still submitted; chunks wait `pending`
  until an AE-capable worker registers. Slack warns when this happens.
- **Worker dies mid-chunk** — existing stale-worker detection (60s) resets the chunk
  to `pending` and another AE worker picks it up; the rest of the render is
  unaffected because chunks are independent.
```
