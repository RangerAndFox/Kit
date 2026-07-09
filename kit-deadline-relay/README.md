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
