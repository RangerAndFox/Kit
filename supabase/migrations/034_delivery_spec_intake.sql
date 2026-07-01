-- Delivery spec intake (Feature #12).
--
-- When Kit posts the "new delivery source" prompt to a project channel, it
-- records an intake row keyed on that message's thread. The operator then
-- replies in-thread with the event spec — as text, a PDF, or a screenshot —
-- and Kit ties the reply back to this row (the paired video+audio sources) so
-- it can extract the spec and submit the render.

CREATE TABLE IF NOT EXISTS delivery_spec_intake (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id text NOT NULL,
  thread_ts text NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open', -- open | consumed
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  UNIQUE (channel_id, thread_ts)
);

CREATE INDEX IF NOT EXISTS delivery_spec_intake_open_idx
  ON delivery_spec_intake (channel_id, thread_ts)
  WHERE status = 'open';

COMMENT ON TABLE delivery_spec_intake IS
  'Pending delivery prompts awaiting a spec reply (text/PDF/screenshot) in their thread.';

-- Match the rest of the schema: RLS on, no policies (service-role only).
ALTER TABLE delivery_spec_intake ENABLE ROW LEVEL SECURITY;
