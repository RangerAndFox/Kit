-- 057_replace_target_identity.sql
--
-- Fix: a 'replace' decision must retain its target's identity even AFTER that
-- target project is deleted by replacement cleanup.
--
-- Migration 056 declared:
--     replace_target_project_id uuid references public.projects(id)
--       on delete set null
--
-- That `on delete set null` is self-defeating for a replace: the archive step
-- DELETES the old project, which cascades and NULLs replace_target_project_id
-- on the very request row that still needs it. If the worker then crashes after
-- the delete but before the durable replace_cleanup step is marked done, a
-- resume re-reads a now-null target, so the cleanup phase disappears — the step
-- stops being required before it was confirmed complete, breaking the
-- "cleanup remains required until done" guarantee (invariant 15).
--
-- The persisted target is an IMMUTABLE identity captured at prompt time, not a
-- live foreign key. Drop the FK constraint so the uuid value survives the
-- target's deletion (and never blocks that deletion). A dangling id after
-- cleanup is expected and handled idempotently: runReplaceCleanup loads the
-- target, finds it already gone, and converges to success. The replay guard
-- (targetId !== newProjectId) still ensures a replay can never archive the
-- freshly created replacement.
--
-- Idempotent + additive: only the constraint is dropped; the column, its type,
-- and all data are unchanged. No backfill.

alter table public.project_creation_requests
  drop constraint if exists project_creation_requests_replace_target_project_id_fkey;

comment on column public.project_creation_requests.replace_target_project_id is
  'Immutable identity of the project a ''replace'' decision must archive, captured at prompt time. Intentionally NOT a foreign key: the value must survive the target project''s deletion so a crash mid-replace resumes against the same target and the durable replace_cleanup step stays required until done. A dangling id after cleanup is expected (the cleanup step then no-ops idempotently).';
