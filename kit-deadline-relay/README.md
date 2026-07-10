# Kit Deadline Relay

Bridges Kit's render queue to an existing **Thinkbox / AWS Deadline** farm, so
`/kit render` submits to Deadline instead of Kit's own worker fleet. You install
this on **one** studio machine — not on every render node. Deadline's own Workers
do the rendering.

## What it does

On a loop, for Deadline-backed renders (`render_backend='deadline'`):

1. **Claims** an `ae_render` request from Supabase.
2. **Prepares the project** by scripting AfterFX.exe on this box: captures each
   QUEUED item's real output module (the deliverable — e.g. ProRes 422 .mov),
   overrides it to a **PNG sequence** (Deadline can only frame-split sequences),
   queues a **WAV duplicate** for audible comps, and saves a farm copy
   (`<name>__kitfarm.aep`) next to the original. The artist's file is untouched.
3. **Submits one Deadline job per queued comp** via `deadlinecommand -SubmitJob`
   — the PNG sequence renders into `<projectDir>\render\<comp>\frames\`,
   frame-split across the farm (`ChunkSize`).
4. **Renders the audio pass locally** (aerender, audio can't be frame-split) →
   `<comp>_audio.wav`.
5. **Polls** the Deadline jobs; when a comp's frames finish, **assembles** them
   with FFmpeg into the artist's original format at the comp's frame rate,
   muxing the audio — the final deliverable (e.g. `MainComp.mov` in ProRes 422)
   appears in `<projectDir>\render\<comp>\`, frames are cleaned up, and status
   rolls back to Supabase → Slack.

So: queue a comp in AE with the output set to ProRes 422, save into
`08_AE\03_RenderFarm\` → the farm renders it in parallel → a ProRes 422 with
audio appears in the render folder.

## Isolation from the production C4D farm

This integration is **strictly additive** and must not alter the existing C4D
setup:

- **The relay only *submits* jobs.** It never runs any Deadline admin/config
  command — it can't change pools, groups, plugins, or repository settings.
- **AE jobs target a dedicated group** (`DEADLINE_GROUP`, e.g. `kit_ae`) so they
  only run on nodes you designate and never displace C4D work. Creating/assigning
  a group is additive; it doesn't touch `c4d_render`.
- **AE 2026 support is added in isolation** (see below) — the stock C4D plugin and
  config are never modified.

## Adding AE 2026 without touching C4D

Good news from the stock `AfterEffects.py`: it builds the executable config key
dynamically — `RenderExecutable<major>_0` from the submitted `Version` — so v26 is
NOT blocked by any version whitelist. It just needs a `RenderExecutable26_0` entry
(the 2022 `.param` only defines fields up to `22_0`). Add it via a **custom plugin
overlay** so nothing stock or C4D is touched:

1. Copy `[repo]\plugins\AfterEffects` → `[repo]\custom\plugins\KitAfterEffects`
2. Rename the 4 files `AfterEffects.*` → `KitAfterEffects.*`
3. Add to `KitAfterEffects.param`:
   ```ini
   [RenderExecutable26_0]
   Type=multilinemultifilename
   Label=After Effects 2026 Render Executable
   Category=Render Executables
   CategoryOrder=0
   Index=14
   Default=C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\aerender.exe
   Description=Path to the AE 2026 aerender executable.
   ```
4. Set `DEADLINE_PLUGIN=KitAfterEffects` and `AE_VERSION=26.0`.

(The `custom/plugins` overlay never modifies stock files. Editing the stock
`AfterEffects.param` instead would also work and is AE-only, but the overlay keeps
it fully isolated.) Every AE render node needs **After Effects 2026** (or its
Render Engine) installed locally.

## Requirements (on this relay box)

- **Node.js 18+**
- **`deadlinecommand`** working (Deadline client installed; the box can reach the
  repository). Verify: `& "$env:DEADLINE_PATH\deadlinecommand.exe" -Pools`
- **After Effects** installed here (the relay opens the `.aep` to read its render
  queue). Point `AFTERFX_PATH` at `AfterFX.exe`.
- Read access to the same project share the render nodes use.

> The render **nodes** each need After Effects (or the AE Render Engine) + the
> Deadline AfterEffects plugin. That's Deadline farm setup, not this relay.

## Install

```powershell
cd kit-deadline-relay
.\install.ps1
npm start
```

The installer prompts for Supabase creds, the Deadline pool/group/priority, the
AE version, the AfterFX path, and the Dropbox→farm path map, then writes `.env`.

Run it unattended with NSSM or Task Scheduler (see kit-render-worker's README for
the same pattern).

## Configuration

All via `.env` — see `.env.example`. Key values:

- **`DEADLINE_PATH_MAP`** — normalizes drive letters to UNC so headless Workers
  resolve the SAN, e.g. `Z:=>\\thewire\production`. UNC input passes through.
- **`AE_VERSION`** — `26.0` for AE 2026 (internal v26).
- **`DEADLINE_PLUGIN`** — `KitAfterEffects` (the AE 2026 overlay) or `AfterEffects`.
- **`DEADLINE_GROUP`** — a dedicated AE group (e.g. `kit_ae`), never a C4D group.

## Switching Kit to this backend

Set `RENDER_BACKEND=deadline` in Kit's (Railway) env. New `/kit render` requests
are then routed to Deadline; leave it unset to use the built-in worker fleet.
