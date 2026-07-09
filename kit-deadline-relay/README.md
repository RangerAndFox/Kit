# Kit Deadline Relay

Bridges Kit's render queue to an existing **Thinkbox / AWS Deadline** farm, so
`/kit render` submits to Deadline instead of Kit's own worker fleet. You install
this on **one** studio machine — not on every render node. Deadline's own Workers
do the rendering.

## What it does

On a loop, for Deadline-backed renders (`render_backend='deadline'`):

1. **Claims** an `ae_render` request from Supabase.
2. **Reads the project's After Effects render queue** by scripting AfterFX.exe on
   this box (`-noui -r inspect.jsx`).
3. **Submits one Deadline job per queued comp** via `deadlinecommand -SubmitJob`
   — image sequences are frame-split across the farm (`ChunkSize`), single-movie
   outputs render whole.
4. **Polls** those Deadline jobs and rolls their status back to Supabase, so
   `/kit render status` in Slack reflects the farm.

The project's render settings + output module (what the artist queued) are used
as-is; only the output *destination* is redirected to `<projectDir>/render/<comp>/`
so it resolves on every node.

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

Your repo's stock AfterEffects plugin (dated 2022) only knows up to CC 2022, so
AE 2026 (internal **v26**) needs a render-executable entry. Two safe, C4D-neutral
options:

- **A. Add the 2026 executable to the AE plugin config** (Deadline Monitor →
  Tools → Configure Plugins → After Effects → set the 2026 `aerender.exe` path).
  This edits only the AfterEffects plugin config, is reversible, and doesn't touch
  C4D. Keep `DEADLINE_PLUGIN=AfterEffects`.
- **B. Ship a custom plugin overlay** — copy the AfterEffects plugin to
  `[repo]\custom\plugins\KitAfterEffects\`, add a `RenderExecutable26_0` entry for
  AE 2026, and set `DEADLINE_PLUGIN=KitAfterEffects`. Deadline's `custom` overlay
  never modifies stock files. Zero risk to the AE *or* C4D stock plugins.

Either way, every AE render node needs **After Effects 2026** (or its Render
Engine) installed locally, and the job's `AE_VERSION=26.0`.

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

All via `.env` — see `.env.example`. The two that always need your values:

- **`DEADLINE_PATH_MAP`** — how a Kit Dropbox path maps to the farm share, e.g.
  `/Projects=>\\thewire\projects;/Delivery-Queue=>\\thewire\delivery`.
- **`AE_VERSION`** — the Deadline AE plugin "Version" (e.g. `2022`, `2024`). Must
  match a render executable the plugin knows on the nodes.

## Switching Kit to this backend

Set `RENDER_BACKEND=deadline` in Kit's (Railway) env. New `/kit render` requests
are then routed to Deadline; leave it unset to use the built-in worker fleet.
