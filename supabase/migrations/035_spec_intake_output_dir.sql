-- 035_spec_intake_output_dir.sql
-- Delivery spec intakes started from an AE render-complete notice deliver the
-- transcode NEXT TO the rendered source (render/<comp>/) instead of the
-- default <sourceDir>/delivery/. The intake row carries that destination and
-- submitJob copies it onto the render job (render_jobs.ae_output_dir), which
-- the transcode worker honors.

begin;

alter table public.delivery_spec_intake
  add column if not exists output_dir text;

commit;
