# Plaud Migration — Design Spec

**Date:** 2026-05-21
**Status:** Approved for implementation planning
**Replaces:** Granola transcript integration

---

## 1. Problem

Kit was wired for Granola as the meeting-transcript source. We are switching to Plaud (https://plaud.ai). The cleanup is small but real: Granola code, settings UI references, env vars, and stale data should all be removed. In their place we want a Plaud webhook endpoint that is *ready to fire* the moment Plaud credentials and a developer app exist — but doesn't try to do real ingest work until then.

Plaud creds are not yet provisioned. The spec is therefore deliberately a skeleton: real HMAC verification (Plaud docs are stable here), but the actual Plaud Transcription API calls are stubbed and gated behind a feature flag.

## 2. Goals

1. Delete all Granola-related code, env vars, UI, and database rows.
2. Stand up `POST /api/webhooks/plaud` with full HMAC-SHA256 signature verification and replay protection.
3. Generalize the `call_transcripts` schema so it is provider-agnostic going forward.
4. Wire the Inngest plumbing for `transcription.completed` / `transcription.failed` so the day Plaud is configured the only switch needed is `PLAUD_INGEST_ENABLED=true`.
5. Surface Plaud setup status in `/settings/integrations` so an operator can see at a glance whether the webhook secret and API key are set.

## 3. Non-Goals

- Building the Plaud OAuth / dev-app provisioning UX. The operator will do that manually in the Plaud developer console.
- Wiring the **Plaud MCP** server (https://docs.plaud.ai/documentation/plaud_app/mcp.md). Out of scope; a future capability for ad-hoc Slack queries like "what did we discuss with Acme on Monday?" — noted, not built.
- Migrating historical Granola RAG embeddings. See §6 — RAG documents have no `source` column to filter on, so Granola-era documents stay in `project_documents` as source-agnostic text. Acceptable trade-off.

## 4. Architecture

```
Plaud cloud
  │
  │  POST /api/webhooks/plaud
  │  headers: plaud-signature, plaud-timestamp
  │  body:    { event, timestamp, data: { transcription_id, file_id, ... } }
  ▼
Next.js route handler  (src/app/api/webhooks/plaud/route.ts)
  1. Read raw body (bytes — Plaud signs raw)
  2. verifyPlaudSignature(body, ts, sig, PLAUD_WEBHOOK_SECRET)
     → HMAC-SHA256 over `${ts}.${body}`, compare `sha256=<hex>`
  3. Reject 401 on bad sig OR |now − plaud-timestamp| > PLAUD_TIMESTAMP_SKEW_SECONDS (default 300s)
  4. Parse event.event:
       'transcription.completed' → inngest.send('plaud/transcription.ready', {data})
       'transcription.failed'    → inngest.send('plaud/transcription.failed', {data})
       (unknown event)           → log + 200 (be permissive on future events)
  5. Return 200 fast (Plaud's webhook timeout is 10s; retries on non-2xx)
  ▼
Inngest function: plaud-transcription-ready
  Idempotency key: data.transcription_id
  if (!PLAUD_INGEST_ENABLED):
    insert into call_transcripts { external_recording_id, external_file_id, source: 'plaud', ingest_status: 'pending' }
    done
  else:
    1. fetchPlaudFile(file_id)              → { name, duration, created_at, participants? }
    2. fetchPlaudTranscript(transcription_id) → { text, speaker_labels, timestamps }
    3. Hand off to existing webhook-router 'transcript' route → CALL_PROCESSOR managed agent
    4. Agent classifies project, ingests to RAG via ingestTranscript()
    5. Update call_transcripts.transcript, .participants, .start_time, .end_time, .ingest_status = 'ingested'

Inngest function: plaud-transcription-failed
  Insert a call_transcripts row with ingest_status='failed' and the error message.
  Post a low-priority Slack notice to a configurable error channel (env: PLAUD_ERROR_CHANNEL_ID, optional).
```

### Design decisions

- **Sync verify, async work.** Signature check and dispatch run in the route handler (must respond <10s). All real work happens in Inngest, which already handles retries and idempotency in Kit.
- **Idempotency.** Inngest event idempotency key is `transcription_id`. Plaud retries (exponential backoff: 30s, 5m, 30m, 2h, 24h, then drop) will not produce duplicate rows.
- **Replay protection.** Reject webhooks whose `plaud-timestamp` differs from server time by more than `PLAUD_TIMESTAMP_SKEW_SECONDS` (default 300). Not strictly required by Plaud's docs but standard.
- **Unknown-event tolerance.** Unknown `event` strings log + 200 rather than 4xx. Plaud may add new event types during beta; we should not trip their retry loop on a forward-compatible payload.

## 5. Components

### Added

- `src/app/api/webhooks/plaud/route.ts` — POST handler. Raw-body read, HMAC verify, dispatch to Inngest, 200.
- `src/lib/integrations/plaud.ts` — exports:
  - `verifyPlaudSignature(rawBody: string, timestamp: string, signature: string, secret: string): boolean`
  - `fetchPlaudTranscript(transcriptionId: string)` — flag-gated stub; throws `Error('PLAUD_INGEST_ENABLED is false')` when off.
  - `fetchPlaudFile(fileId: string)` — same.
  - Types: `PlaudTranscriptionCompletedEvent`, `PlaudTranscriptionFailedEvent`, `PlaudTranscript`, `PlaudFile`.
- `src/lib/inngest/agents/plaud.ts` — Inngest functions `plaud-transcription-ready` and `plaud-transcription-failed`.
- Supabase migration `20260521_plaud_migration.sql`:
  ```sql
  alter table call_transcripts rename column granola_call_id to external_recording_id;
  alter table call_transcripts add column external_file_id text;
  alter table call_transcripts add column ingest_status text default 'pending'
    check (ingest_status in ('pending', 'ingested', 'failed'));
  alter table call_transcripts alter column transcript drop not null;
  alter table call_transcripts alter column participants drop not null;
  alter table call_transcripts alter column start_time drop not null;
  alter table call_transcripts alter column end_time drop not null;
  create unique index if not exists call_transcripts_external_recording_id_key
    on call_transcripts (external_recording_id);
  create index if not exists call_transcripts_source_ingest_status_idx
    on call_transcripts (source, ingest_status);
  delete from call_transcripts where source = 'granola';
  ```
  Note: `NULL`-allow on `transcript`/`participants`/`start_time`/`end_time` is required for skeleton rows.

### Changed

- `src/lib/managed-agents/webhook-router.ts` — comment update on the `'transcript'` route (Granola → Plaud). No logic change.
- `src/lib/integrations/registry.ts` — replace Granola integration entry with Plaud entry, same shape.
- `src/app/(app)/settings/integrations/page.tsx` — Plaud card replaces Granola card. Shows: webhook URL, env-var presence indicators (`PLAUD_WEBHOOK_SECRET`, `PLAUD_API_KEY`), `PLAUD_INGEST_ENABLED` state, link to Plaud dev console.
- `src/app/(app)/settings/security/page.tsx` — Granola webhook-secret row → Plaud webhook-secret row.
- `src/lib/agent/call-classifier.ts` — generalize any `source === 'granola'` branches to handle `source ∈ {'plaud', 'manual'}`.
- `src/lib/inngest/orchestrator.ts` and `src/lib/inngest/agents/registry.ts` — register the new Plaud functions.

### Deleted

- `src/lib/integrations/granola.ts` (whole file; `processGranolaTranscript` is unreferenced in live code paths, confirmed via grep).
- All Granola references in `.env.example` and README.
- `call_transcripts` rows where `source='granola'` (in the migration).

### Untouched

- `src/lib/managed-agents/CALL_PROCESSOR` agent — Plaud routes through the same `'transcript'` webhook-router entry once `PLAUD_INGEST_ENABLED` flips on.
- `src/lib/rag/ingest.ts` — already provider-agnostic.

## 6. Data Model

`call_transcripts` (existing table, generalized):

| Column                 | Before                          | After                                          |
|------------------------|---------------------------------|------------------------------------------------|
| `granola_call_id`      | text, unique, NOT NULL          | renamed → `external_recording_id` (text, unique) |
| _(new)_                | —                               | `external_file_id` text                        |
| `source`               | text, e.g. `'granola'`          | text, values now `'plaud' \| 'manual'`         |
| `transcript`           | text, NOT NULL                  | text, **NULL allowed**                         |
| `participants`         | jsonb, NOT NULL                 | jsonb, NULL allowed                            |
| `start_time`           | timestamptz, NOT NULL           | timestamptz, NULL allowed                      |
| `end_time`             | timestamptz, NOT NULL           | timestamptz, NULL allowed                      |
| _(new)_                | —                               | `ingest_status` text default `'pending'` (check: pending/ingested/failed) |

Skeleton rows (created when `PLAUD_INGEST_ENABLED=false`) carry only `external_recording_id`, `external_file_id`, `source='plaud'`, `ingest_status='pending'`. Backfill query when the flag flips:

```sql
select external_recording_id, external_file_id
from call_transcripts
where source='plaud' and ingest_status='pending';
```

The Inngest job will iterate, hydrate, and mark `ingested`. (Backfill runbook lives outside this spec.)

### RAG documents — known trade-off

`project_documents` (RAG table) has no `source` column. Granola-era documents are identifiable only by title pattern (`"Call: <date>"`) and `category='founder'` — a fragile heuristic. We accept that those documents remain in the RAG store as source-agnostic text+embeddings. They will surface in retrieval results but no longer have a corresponding `call_transcripts` row backing them.

## 7. Configuration

### New env vars

| Name                            | Required when           | Purpose                                       |
|---------------------------------|-------------------------|-----------------------------------------------|
| `PLAUD_WEBHOOK_SECRET`          | always (for signature)  | HMAC secret from Plaud dev console            |
| `PLAUD_API_KEY`                 | `PLAUD_INGEST_ENABLED=true` | App-level API token for Transcription API |
| `PLAUD_INGEST_ENABLED`          | optional, default false | Gates transcript fetch + RAG ingest           |
| `PLAUD_TIMESTAMP_SKEW_SECONDS`  | optional, default 300   | Replay-protection window                      |
| `PLAUD_ERROR_CHANNEL_ID`        | optional                | Slack channel for `transcription.failed` notices |

### Removed env vars

- `GRANOLA_WEBHOOK_SECRET` (and any other `GRANOLA_*`).

### Docs

- README "Webhook integrations" section: Granola row replaced with Plaud row, listing the env vars above, the webhook URL pattern `https://<host>/api/webhooks/plaud`, and a link to https://docs.plaud.ai/.

## 8. Testing

### Unit

- `verifyPlaudSignature`:
  - Known-good fixture (timestamp + body + secret → expected signature).
  - Tampered body → returns false.
  - Wrong secret → returns false.
  - Stale timestamp → caller in route handler rejects.
  - Missing or malformed `sha256=` prefix → returns false.
- Inngest `plaud-transcription-ready`:
  - Flag off → skeleton row inserted, no fetch calls.
  - Flag on → mocks for `fetchPlaudFile` and `fetchPlaudTranscript` resolve, CALL_PROCESSOR invocation asserted, `ingest_status='ingested'`.
  - Duplicate event (same `transcription_id`) → idempotent, second call is no-op.
- Inngest `plaud-transcription-failed`:
  - Row written with `ingest_status='failed'` and the error message.
  - If `PLAUD_ERROR_CHANNEL_ID` is set, Slack `chat.postMessage` is called.

### Integration (deferred until Plaud creds exist)

1. Create dev app in Plaud console, set `PLAUD_WEBHOOK_SECRET` in staging Railway.
2. Configure webhook URL = staging `/api/webhooks/plaud`.
3. Record a 30s test note via Plaud device or app.
4. Confirm: a `call_transcripts` row appears with `ingest_status='pending'`, correct `external_recording_id`, `source='plaud'`.
5. Set `PLAUD_API_KEY` + `PLAUD_INGEST_ENABLED=true`. Re-fire (or wait for next recording).
6. Confirm: same row updates with full `transcript`, `participants`, timestamps, `ingest_status='ingested'`. RAG document created. CALL_PROCESSOR ran (Inngest logs).

## 9. Rollout

1. **PR merge.** Granola deleted, Plaud skeleton live, flag off. Production no-op — no Plaud webhooks fire yet because no dev app exists.
2. **Operator step (outside spec).** Create Plaud dev app, copy webhook secret + API key into Railway. Set webhook URL in Plaud console to production `/api/webhooks/plaud`.
3. **Live verification.** Real recording produces a skeleton row in `call_transcripts`.
4. **Flag flip.** Set `PLAUD_INGEST_ENABLED=true` in Railway. Future recordings ingest fully. Run the backfill query against `pending` skeleton rows to hydrate them.
5. **Decommission.** After 30 days, drop `granola_call_id` references from any external documentation or onboarding material.

## 10. Open Questions / Risks

- **Plaud webhook payload may differ from docs.** Webhook is documented for `transcription.completed` / `transcription.failed`; if Plaud adds fields, we will see them but ignore unknown keys (safe). If they rename fields, signature verification still passes but our parser may break — mitigated by the unknown-event tolerance and by integration testing in staging before prod flag-flip.
- **Participants enrichment.** Plaud's webhook does not carry participant identities; `fetchPlaudFile` *may* return them (docs are vague). If participants are not retrievable via API, the downstream pre-meeting briefings feature (next spec) will need a separate mapping strategy (manual tag, calendar correlation, speaker-label dictionary). Not blocking for this spec.
- **MCP overlap.** Plaud also exposes an MCP server with `get_transcript` / `get_note`. Future spec may switch the fetch path to MCP instead of the Transcription API for richer summaries. Out of scope here.

---

**Next step after approval:** invoke `superpowers:writing-plans` against this spec to produce the implementation plan.
