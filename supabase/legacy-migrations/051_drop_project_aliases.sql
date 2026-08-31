-- Revert 050_project_aliases. A manual per-project alias registry was the
-- wrong tool: internal projects already carry the keyword in their name
-- (e.g. "2630A_Internal_Marshmallow_Man"), and studio-knowledge now falls
-- back to the Harvest fuzzy scorer, which resolves "marshmallow" without any
-- alias upkeep. Drop the speculative column.
drop index if exists idx_projects_aliases;
alter table public.projects drop column if exists aliases;
