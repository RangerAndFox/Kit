# AE Render Farm — Session Handoff

**Session date:** 2026-07-11 · **Branch:** `claude/ae-render-farm-setup-rknea3` (all merged to `main` via PRs #51, #89, #90)
**Specs:** `AE-RENDER-FARM-SPEC.md` (architecture detail) · `CLAUDE.md` Phase 7, items 28–39 (context summary)

## What was built

An After Effects render farm for Kit that renders a project's **own render queue**
across the studio's existing **Thinkbox Deadline** farm, then assembles the frames
into the artist's intended deliverable format — triggered by dropping a `.aep`
into a watch folder or via `/kit render` in Slack.

### The complete flow (production path)

```
Artist: queue comp(s) in AE (output module = real deliverable, e.g. ProRes 422),
        save .aep into <project>\08_AE\03_RenderFarm\
   │  Dropbox syncs → webhook fires
   ▼
Kit (Railway, bolt/src/watchers/dropbox.ts)
   matches /production/<year>/<safeName>/08_AE/03_RenderFarm/<file>.aep
   dedupes on Dropbox id@rev (ledger key "aefarm:<id>@<rev>" in seen_dropbox_files)
   skips "(conflicted copy)" and "__kitfarm.aep"
   translates to UNC: \\thewire\production\<year>\<safeName>\08_AE\03_RenderFarm\<file>
   inserts render_jobs row: job_type='ae_render', render_backend='deadline',
     status='processing', claimed_by=null
   posts ":clapper: render queued" to the project channel
   ▼
kit-deadline-relay (Node service on AC-Slater, C:\Kit\kit-deadline-relay)
   claims the parent (atomic UPDATE ... WHERE claimed_by IS NULL)
   1. PREPARE (AfterFX.exe -noui -r prepare.jsx):
      per QUEUED rq item: record comp/fps/frame range, original OM filename +
      om.getSettings() JSON blob (codec sniffing), layer-scan for audio;
      override OM → PNG sequence; if audio, item.duplicate() with OM → WAV;
      save farm copy <name>__kitfarm.aep next to original (artist file untouched)
   2. SUBMIT: per comp, deadlinecommand -SubmitJob (job_info + plugin_info files)
      Plugin=KitAfterEffects, Group=kit_ae, Pool=none, Version=26.0
      Comp=<name> (aerender -comp renders the FIRST queued instance → the video
      item, never the audio dup), SceneFile=farm copy,
      Output=<projectDir>\render\<comp>\frames\<comp>_[#####].png,
      Frames=<start>-<end>, ChunkSize=10 (frame-split across the farm)
   3. AUDIO PASS (local): aerender -rqindex <dupIdx> → render\<comp>\<comp>_audio.wav
   4. POLL: deadlinecommand -GetJob → on completed:
   5. ASSEMBLE (FFmpeg local): frames @ comp fps → sniffed original format
      (ProRes 422/LT/HQ/Proxy/4444 via prores_ks, H.264 via libx264+aac/.mp4;
      default ProRes 422 .mov), mux WAV with -shortest, output
      render\<comp>\<original OM filename>, delete frames (AE_KEEP_FRAMES=false)
   parent → status='complete', deadline_jobs jsonb carries per-comp state
   ▼
Kit notifier (per-minute node-cron in bolt/src/app.ts → src/lib/delivery/ae-notify.ts)
   posts ✅/❌ with per-comp output paths, idempotent via slack_notified_status
   complete notice carries an "Add delivery specs" button (kit_ae_add_specs)
   ▼
Spec follow-up (optional): button → spec-intake thread on the notice
   (delivery_spec_intake row; sources = assembled render(s), UNC→Dropbox via
   uncToDropboxPath). Operator replies with spec text/PDF/screenshot; extra
   files join via "audio: /production/....wav" lines (extractAudioPathsFromText).
   Existing extractor → delivery profile → transcode render_job whose
   ae_output_dir = the render/<comp>/ dir, so the deliverable lands NEXT TO the
   source (worker output-dir override), not in /delivery.
```

`/kit render` (Slack modal, one field: the SAN `.aep` path) submits the same
parent row manually. `/kit render status` lists renders with progress.

## Two backends (`RENDER_BACKEND` env on Railway)

- **`deadline`** (ACTIVE): the flow above. One relay box; no per-node installs.
- **`kit-worker`** (fallback, built but not deployed for AE): kit-render-worker
  fleet claims `ae_inspect` → `ae_chunk` (aerender -rqindex, frame-split) →
  `ae_stitch` jobs via Supabase polling; Dropbox-synced paths. Migrations 032/033.

## Code map

| Area | Files |
|---|---|
| Relay (new app) | `kit-deadline-relay/src/{index,config,supabase,storage,path-map,inspect,job-info,deadline,submit,audio,assemble,poll}.ts` + `install.ps1`, `.env.example` (force-added past the root `.env*` gitignore) |
| Watch folder | `bolt/src/watchers/dropbox.ts` — `AE_RENDERFARM_RE`, `matchAeRenderFarmDrop`, `handleAeRenderFarmDrop` |
| Notifier + spec button | `src/lib/delivery/ae-notify.ts` (cron registered in `bolt/src/app.ts`), `kit_ae_add_specs` handler in `bolt/src/delivery/submit-handler.ts` |
| Spec intake additions | `bolt/src/delivery/spec-intake.ts` (`extractAudioPathsFromText`, `outputDir` passthrough), `src/lib/delivery/spec-intake-store.ts` (`output_dir`), `src/lib/delivery/storage.ts` (`submitJob.outputDir` → `ae_output_dir`) |
| Kit AE plumbing | `src/lib/delivery/ae-storage.ts` (`submitAeRenderFromProject`, `claimDeadlineParent`, `getAeRenderStatus`, `listAeRenders`, `uncToDropboxPath`), `frame-planner.ts`; `delivery` agent actions `render_project`/`submit_ae_render`/`ae_render_status`/`list_ae_renders` |
| Slack | `/kit render` in `bolt/src/handlers/commands.ts`, modal `bolt/src/delivery/render-modal.ts` |
| kit-worker AE path | `kit-render-worker/src/aerender/*`, `src/ae-processor.ts`, claimer/processor/heartbeat/config wiring; transcode worker honors `ae_output_dir` |

## Schema (all applied to live Supabase project `ozsxrcgrezpffnpwlrnq`)

- **032 `ae_render_farm`**: `render_jobs.job_type` (`transcode|ae_render|ae_chunk|ae_stitch`) + parent/chunk/frame/AE columns + `delivery_profile_id`, `aerender_command`; `render_workers.ae_capable/aerender_path/ae_version`; indexes.
- **033 `ae_render_queue`**: adds `ae_inspect` to the job_type check; `ae_rqindex`, `ae_is_movie`, `render_queue` jsonb.
- **034 `deadline_backend`**: `render_backend` (`kit-worker|deadline`) + `deadline_jobs` jsonb.
- **035 `spec_intake_output_dir`**: `delivery_spec_intake.output_dir`.
- Notifier reuses migration 020's `slack_notified_status/at` (previously unused).
- NOTE: live migration names differ from repo file numbers (the live project had
  its own 032–035 series) — applied under names `ae_render_farm`, `ae_render_queue`,
  `deadline_backend`, `spec_intake_output_dir`.

## Farm / infra state (as configured this session)

- **Deadline 10.2.1.1**, repo `\\thewire\deadline\DeadlineRepository10`.
- **C4D is production-critical and untouched** — C4D schedules by POOL (`Pool=c4d`,
  `Group=none`; verified on live jobs), so group changes can't affect it. The
  relay is submit-only (`-SubmitJob`/`-GetJob` only, no admin commands).
- **Group `kit_ae` created**; all 8 workers added (AC-Slater, BaysideHigh, Bunk,
  Carlton, Slim-Charles, Stringer, TedsPC, Zack-Morris — all run AE 2026).
  ⚠️ CLI note: `deadlinecommand -GetSlaveGroups` is NOT a valid 10.2 command;
  `-SetGroupsForSlave <node> "<g1,g2>"` OVERWRITES the group list. Nodes were set
  to `none,kit_ae`. Use the Monitor GUI for group edits.
- **KitAfterEffects custom plugin**: operator copied `plugins\AfterEffects` →
  `custom\plugins\KitAfterEffects` and added a `RenderExecutable26_0` param
  pointing at AE 2026's aerender (stock `AfterEffects.py` builds the config key
  dynamically from Version, so 26.0 resolves once the entry exists).
- **Relay installed + running on AC-Slater** (`C:\Kit\kit-deadline-relay`,
  `npm start`; env via `install.ps1`): Plugin=KitAfterEffects, Group=kit_ae,
  AE_VERSION=26.0, DEADLINE_PATH_MAP=`Z:=>\\thewire\production`, FFmpeg 8.1.2
  installed via winget. Not yet a Windows service (NSSM/Task Scheduler pending).
- **Railway**: `RENDER_BACKEND=deadline` set (operator). Bolt deploys from `main`.
- Windows PowerShell 5.1 quirks hit twice: scripts must be ASCII (no em dashes /
  box chars — mis-decoded without BOM) and each new shell needs
  `Set-ExecutionPolicy -Scope Process Bypass -Force` before `.ps1`/npm.

## NOT yet verified (first live render will exercise these)

1. `om.getSettings(GetSettingsFormat.STRING)` blob shape in AE 2026 → codec
   sniff (`assemble.ts sniffTargetFormat`) — fallback is ProRes 422 .mov.
2. `om.setSettings({"Format":"PNG Sequence"})` and `{"Format":"WAV"}` in AE 2026
   — fallbacks: `applyTemplate("PNG Sequence"/"Multi-Machine Sequence"/"AIFF 48kHz")`,
   then whole-movie render (no split/assemble) if all fail.
3. `deadlinecommand -GetJob` Status line parsing (`deadline.ts getJobStatus`).
4. Deadline AfterEffects plugin accepting `Output` with AE `[#####]` padding.
5. End-to-end watch-folder trigger timing (webhook → sync latency).

**Test procedure:** short comp (few seconds, ProRes 422 OM, with audio) queued in
a `.aep` → save into `08_AE\03_RenderFarm\` of a project with a linked Slack
channel → watch relay console on AC-Slater + Deadline Monitor + the channel.
Expected: queued notice → KitAfterEffects job in `kit_ae` → frames → assembled
ProRes with audio in `render\<comp>\` → ✅ notice with "Add delivery specs" button.

## Known gaps / next steps

- **kit-render-worker not installed anywhere** — required for the spec-follow-up
  transcodes (Dropbox-resolved). Install on AC-Slater
  (`kit-render-worker\install.ps1`, `DROPBOX_SYNC_PATH` = local `/production`
  sync root).
- **Relay & worker as Windows services** (NSSM or Task Scheduler) so they survive
  reboots; currently foreground `npm start`.
- **Multiple external audio files per transcode**: worker takes ONE audio source
  (interleaved multichannel WAV works); separate mono splits need the amerge
  path (`requiresAmerge` currently throws).
- Same comp queued twice in one project: `aerender -comp` renders only the first
  queued instance.
- Temporal-dependency effects (heavy motion blur/frame blending) can seam at
  Deadline chunk boundaries; raise `DEADLINE_CHUNK_SIZE` or expect whole-movie
  fallback comps to render unsplit.
- Watch-folder path assumption: Dropbox `/production/<year>/<safeName>/...`
  mirrors `\\thewire\production\...` (`AE_FARM_UNC_ROOT` env to change).
