-- Brain scavenger: track when a candidate's approval DM was sent.
--
-- The dispatch cron used to re-DM every still-pending candidate on every
-- run (identical message, daily) because nothing recorded that a DM had
-- gone out. dm_sent_at makes dispatch idempotent per candidate — DM once,
-- one re-remind after a week — which also makes an hourly dispatch safe
-- (fixing the scan-after-dispatch-window split-brain between the Inngest
-- scan and the Railway dispatch cron).

ALTER TABLE brain_scavenger_candidates ADD COLUMN IF NOT EXISTS dm_sent_at timestamptz;

COMMENT ON COLUMN brain_scavenger_candidates.dm_sent_at IS
  'When the approval DM for this candidate was last sent. Null = never DM''d. Dispatch re-sends only after a stale cutoff (weekly re-remind).';
