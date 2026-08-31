-- Complete the four-tab Project Control model promised by the product UI.
-- Existing projects are backfilled idempotently by the canonical Sheet→Canvas
-- sync after PROJECT_VIEW_RENDER_VERSION advances.

alter table public.project_control_canvases
  drop constraint if exists project_control_canvases_type_check;

alter table public.project_control_canvases
  add constraint project_control_canvases_type_check
  check (canvas_type = any (array[
    'overview'::text,
    'reference'::text,
    'schedule'::text,
    'notesAndFeedback'::text
  ]));

comment on table public.project_control_canvases is
  'One durable generated Slack Canvas binding per project and view: overview, reference, schedule, notesAndFeedback.';
