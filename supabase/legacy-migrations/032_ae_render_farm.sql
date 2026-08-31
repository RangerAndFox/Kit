-- 032_ae_render_farm.sql
-- After Effects render farm — extends the existing distributed render pipeline
-- (migration 019) to support aerender jobs that frame-split one comp across the
-- studio's machines, then stitch the resulting image sequence with FFmpeg.
--
-- Design: reuse render_jobs / render_workers. A single render request becomes:
--   • one parent row      (job_type = 'ae_render',  never claimed — a tracker)
--   • N chunk rows        (job_type = 'ae_chunk',   each a frame range, claimed
--                          only by AE-capable workers)
--   • one stitch row      (job_type = 'ae_stitch',  created when all chunks are
--                          done — encodes the sequence; any FFmpeg worker can run it)
--
-- Spec: AE-RENDER-FARM-SPEC.md (repo root).

begin;

-- ─── render_jobs: job-type discriminator + AE/chunk fields ─────────────────

alter table public.render_jobs
  add column if not exists job_type text not null default 'transcode'
    constraint render_jobs_job_type_check
    check (job_type in ('transcode', 'ae_render', 'ae_chunk', 'ae_stitch'));

alter table public.render_jobs
  -- Chunk → parent linkage (null for transcode + ae_render parent rows)
  add column if not exists parent_job_id uuid references public.render_jobs(id) on delete cascade,
  add column if not exists chunk_index integer,
  add column if not exists chunk_count integer,

  -- Frame range this row is responsible for (inclusive, 0-based comp frames)
  add column if not exists frame_start integer,
  add column if not exists frame_end integer,
  add column if not exists total_frames integer,

  -- After Effects project + render parameters
  add column if not exists ae_project_path text,        -- Dropbox path to the .aep
  add column if not exists ae_comp text,                 -- composition name to render
  add column if not exists ae_render_settings_template text, -- AE Render Settings template name
  add column if not exists ae_output_module_template text,   -- AE Output Module template name
  add column if not exists ae_output_pattern text,       -- e.g. "Comp1_[#####].png"
  add column if not exists ae_output_dir text,           -- Dropbox dir for the rendered frames
  add column if not exists frame_rate text,              -- comp fps, used by the stitch encode

  -- Optional delivery profile to encode the stitched sequence with
  add column if not exists delivery_profile_id uuid references public.delivery_profiles(id) on delete set null,

  -- Debug: the actual aerender command this row ran
  add column if not exists aerender_command text;

-- Index the chunk → parent lookups used by the finalize check
create index if not exists render_jobs_parent_idx
  on public.render_jobs(parent_job_id) where parent_job_id is not null;

-- The existing pending index doesn't know about job_type; add one the claimer
-- can use to skip AE chunks on non-AE-capable workers.
create index if not exists render_jobs_pending_type_idx
  on public.render_jobs(job_type, status, created_at) where status = 'pending';

-- ─── render_workers: After Effects capability ──────────────────────────────

alter table public.render_workers
  add column if not exists ae_capable boolean not null default false,
  add column if not exists aerender_path text,
  add column if not exists ae_version text;

create index if not exists render_workers_ae_idx
  on public.render_workers(ae_capable) where ae_capable = true;

commit;
