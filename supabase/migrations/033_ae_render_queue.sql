-- 033_ae_render_queue.sql
-- Render-queue-driven After Effects renders. Instead of the submitter supplying
-- comp / frames / fps, Kit reads the .aep's own After Effects Render Queue and
-- renders every queued item using the project's render settings + output module.
--
-- Because Kit (on Railway) can't open a .aep, an AE-capable worker performs an
-- `ae_inspect` step first: it scripts After Effects to dump the render queue,
-- then fans the queued items out into ae_chunk rows (frame-split for image
-- sequences, whole-render for single-movie outputs).
--
-- Spec: AE-RENDER-FARM-SPEC.md, "Render-queue-driven renders".

begin;

-- Allow the new inspect job type.
alter table public.render_jobs
  drop constraint if exists render_jobs_job_type_check;
alter table public.render_jobs
  add constraint render_jobs_job_type_check
  check (job_type in ('transcode', 'ae_render', 'ae_inspect', 'ae_chunk', 'ae_stitch'));

alter table public.render_jobs
  -- Which After Effects render-queue item this chunk renders (1-based, as AE
  -- indexes them). Chunks pass `aerender -rqindex N` so they inherit the item's
  -- render settings + output module.
  add column if not exists ae_rqindex integer,
  -- True when the queue item outputs a single movie file (can't be frame-split;
  -- rendered whole on one machine, no stitch).
  add column if not exists ae_is_movie boolean not null default false,
  -- The dumped render queue (array of items) captured by the inspect step,
  -- stored on the parent ae_render row for visibility/debugging.
  add column if not exists render_queue jsonb;

commit;
