-- 034_deadline_backend.sql
-- Pluggable render backend. AE renders can be executed either by the built-in
-- kit-render-worker fleet (default) or by handing them to an existing Thinkbox/
-- AWS Deadline farm via the kit-deadline-relay.
--
-- When render_backend = 'deadline', Kit creates only the ae_render parent (no
-- ae_inspect/ae_chunk rows). The relay picks the parent up, reads the render
-- queue, submits one Deadline job per queued comp, and tracks them in
-- deadline_jobs while reporting aggregate progress back to Slack.
--
-- Spec: AE-RENDER-FARM-SPEC.md, "Backend: Deadline".

begin;

alter table public.render_jobs
  add column if not exists render_backend text not null default 'kit-worker'
    constraint render_jobs_render_backend_check
    check (render_backend in ('kit-worker', 'deadline')),
  -- Per-comp Deadline jobs the relay submitted for this parent:
  -- [{ "comp": "Main", "deadline_job_id": "abc123", "frames": "0-299",
  --    "status": "Rendering", "output_dir": "\\\\thewire\\projects\\...\\render\\Main" }]
  add column if not exists deadline_jobs jsonb;

commit;
