-- Persistent conversation memory (restart-survival).
--
-- Kit's conversational state (recent turns + awaiting-clarification flag,
-- 15-min TTL) lived only in process memory: every Railway deploy dropped
-- mid-conversation context and pending clarifications, so users' answers
-- landed on a Kit that had forgotten the question.
--
-- One row per (team, channel, user) key, write-through on every turn,
-- restored into memory at boot. Rows expire with the same TTL as memory —
-- the boot restore ignores stale rows and the sweeper deletes them.

CREATE TABLE IF NOT EXISTS conversation_state (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_state_updated_idx ON conversation_state (updated_at);

COMMENT ON TABLE conversation_state IS
  'Write-through mirror of Kit''s in-memory conversation state (15-min TTL). Exists so a Railway redeploy doesn''t drop mid-conversation context.';

-- Match the rest of the schema: RLS on, no policies (service-role only).
ALTER TABLE conversation_state ENABLE ROW LEVEL SECURITY;
