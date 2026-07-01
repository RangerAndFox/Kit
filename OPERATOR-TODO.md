# Kit — Operator TODO

Everything that requires you (Steve) to do something before a feature is fully live. Organized by readiness so you can knock items off in any order.

Most items are independent. The few with prerequisites are flagged.

---

## A. Self-serve right now (no external blockers)

These you can do today.

### A1. Set `OPENAI_API_KEY` in Railway
**Why:** Required for studio knowledge (RAG embeddings). Without it, the `studio_knowledge` agent will error on every call.
**Where:** Railway → Kit service → Variables.
**Unlocks:** Everything in §3 of `FEATURES.md` (project history, contacts, notes, transcripts retrieval).

### A2. Run the project backfill
**Why:** Pulls all your Harvest projects into Supabase + embeds each into RAG so Kit can find them.
**How:**
```bash
cd C:\Users\studi\Kit
npx tsx scripts/backfill-projects-from-harvest.ts
```
**Prerequisites:** A1 done; also needs `HARVEST_ACCESS_TOKEN`, `HARVEST_ACCOUNT_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `KIT_DEFAULT_WORKSPACE_ID` in your local `.env` (same values as Railway).
**Idempotent:** safe to re-run.
**Expected output:** "Projects: N inserted, 0 updated, 0 skipped." then "Embedded: N, failed: 0."

### A3. Run the contacts backfill
**Why:** Pulls Harvest clients + contacts into `client_profiles` + embeds them. Enables Kit to answer "who do we talk to at Microsoft?".
**How:**
```bash
npx tsx scripts/backfill-clients-from-harvest.ts
```
**Prerequisites:** A1 + A2 done (project counts come from the local `projects` table).

### A4. Set `DELIVERY_NOTIFY_CHANNEL_ID` in Railway
**Why:** Without this, Kit's Dropbox watcher won't announce new files. Manual `/kit deliver <path>` still works.
**Where:** Railway → Kit service → Variables. Use the channel ID (not name) — get it from Slack via channel → details → "Copy channel ID" at the bottom.

### A5. Install FFmpeg on each studio PC that'll be a render worker
**How:** `choco install ffmpeg` (Chocolatey). Confirm `ffmpeg -version` works.
**Unlocks:** Step E1 below.

---

## B. Slack app config

Confirmed done; listed so we don't lose track.

- ✅ `canvases:write` scope added (used by project channel canvas provisioning).
- The existing `/kit` slash command automatically handles all sub-commands (`note`, `deliver`, `profiles`, `workers`). No new commands to register.

---

## C. Pre-meeting briefings activation (Google Cloud)

All self-serve once you decide to enable.

### C1. Create a Google Cloud service account
**Where:** https://console.cloud.google.com → IAM & Admin → Service Accounts → Create.
**Download:** The JSON key file. Keep it secure.

### C2. Share each Kit-relevant calendar with the service account
For each Google Calendar you want Kit to watch (team calendars, project-specific calendars, etc.):
- Open the calendar's settings
- Share with the service account's `client_email` (from the JSON)
- Grant "See all event details" (read-only is fine)

### C3. Set Railway env vars
```
GOOGLE_SERVICE_ACCOUNT_JSON=<paste the JSON, base64-encoded recommended>
GOOGLE_CALENDAR_IDS=<comma-separated calendar IDs>
KIT_DEFAULT_WORKSPACE_ID=<your workspace uuid — already required for Plaud + studio-knowledge>
BRIEFING_LEAD_TIME_MINUTES=30           # optional, default
BRIEFING_MATCH_THRESHOLD=0.5            # optional, default
BRIEFING_DM_PRODUCER=false              # leave false until project→producer mapping exists
```

### C4. Flip the activation flag
```
GOOGLE_CALENDAR_INGEST_ENABLED=true
```

### C5. Smoke test
Create a calendar event 35 min in the future with you as an attendee. Wait. Confirm the briefing posts to the project's Slack channel ~30 min before the meeting.

---

## D. Plaud transcript activation (waiting on Plaud dev access)

Blocked on Plaud — they gate developer access behind a contact form.

### D1. Apply at https://dev.plaud.ai
**Tell them you need:**
- Developer console access (Client ID + Secret Key)
- **Manual webhook URL registration** at `https://<your-vercel-host>/api/webhooks/plaud` (Plaud's portal UI for webhooks is "coming soon" per their docs)
- The webhook signing secret returned to you

### D2. Once Plaud responds, set Railway env vars
```
PLAUD_WEBHOOK_SECRET=<from Plaud>
PLAUD_INGEST_ENABLED=false              # keep false for the handshake test
PLAUD_TIMESTAMP_SKEW_SECONDS=300        # optional, default
PLAUD_ERROR_CHANNEL_ID=<optional Slack channel for failure notices>
```

### D3. Smoke-test the webhook handshake
- Record a 30-second test note on Plaud.
- Wait ~30 seconds.
- Confirm a row appears in Supabase `call_transcripts` with `source='plaud'`, `ingest_status='pending'`, `external_recording_id` populated.
- If Plaud's webhook log shows 401s, the signature secret is wrong.
- If 404s, the URL or your Vercel deploy is off.

### D4. Verify Plaud File API field name
Before activating ingest, hit `GET https://api.plaud.ai/v1/files/<file_id>` with your API key once. Check whether duration is reported as `duration`, `duration_seconds`, or `seconds`. If it's not `duration_seconds`, update `PlaudFile` in `src/lib/integrations/plaud.ts`. Paste me the API key and I'll do this for you in one call.

### D5. Flip the activation flag
```
PLAUD_API_KEY=<from Plaud>
PLAUD_INGEST_ENABLED=true
```

Record another test note. Confirm:
- `call_transcripts` row updates to `ingest_status='ingested'` with transcript text populated.
- A `project_documents` row appears with `doc_type='call_transcript'` (auto-embed from studio knowledge P4).
- Kit can now answer questions about that meeting via `@Kit ...`.

---

## E. Studio PC installs (delivery pipeline workers)

Each studio PC that'll claim transcode jobs.

### E1. Primary render box
```powershell
# Copy or git-clone the kit-render-worker/ folder to the machine
cd kit-render-worker
.\install.ps1
npm install
npm start
```
Answer the prompts:
- Hostname: default is fine (auto-detects)
- Role: `primary`
- Priority: `1`
- Dropbox sync folder: e.g. `D:\Dropbox`
- FFmpeg path: `ffmpeg` (if on PATH) or full path

### E2. Editor workstations as fallback
Same install steps but answer:
- Role: `fallback`
- Priority: `10` (higher number = lower priority)

Install on 1-2 editor workstations so jobs don't stall when the primary is busy or offline.

### E3. (Optional) Run worker as a Windows service
For unattended operation: use NSSM (`nssm install KitRenderWorker ...`) or Task Scheduler (trigger at logon, run `npm start`). Instructions in `kit-render-worker/README.md`.

### E4. Verify
From Slack: `/kit workers` should show all installed workers as green with their CPU/disk stats.

### E5. End-to-end smoke test
- Drop a 30-second test file in `/Delivery-Queue/<project>/` on Dropbox.
- Wait ~60-90 seconds.
- Confirm Kit posts in `DELIVERY_NOTIFY_CHANNEL_ID` Slack channel with a "Pick a profile" prompt.
- Run `/kit deliver <that path>` → pick Microsoft Ignite 2025 → fill in naming fields → submit.
- Watch `/kit deliver status` for progress.
- Verify output appears in `/Delivery-Queue/<project>/delivery/STUDIO100_BradS_V1_Ignite25.mov`.

---

## F. Studio knowledge polish (optional)

### F1. Enable nightly auto-summarization
**Why:** Once notes + transcripts accumulate, Kit can replace static project summaries with Claude-written narrative versions nightly.
**Where:** Railway.
**How:**
```
STUDIO_KNOWLEDGE_AUTO_SUMMARIZE_ENABLED=true
```
**Recommendation:** wait 2-3 weeks of real usage so the rewrites have material to draw from. Until then, the static P1 summaries from the backfill are sufficient.

### F2. Project → producer mapping (unlocks briefing producer DMs)
Today briefings post to the project channel only. If you want each briefing to also DM the project's producer, the `staff` table needs to know who's on each project. Until that mapping exists, `BRIEFING_DM_PRODUCER=false` (default) prevents Kit from DMing the same producer for every briefing.

This is real follow-on work (schema change, UI to assign, default behaviors). Not blocking anything — just flagged.

---

## G. Code-quality follow-ups (no rush)

These are deferred from end-of-PR reviews. Each is its own small PR.

### G1. Strip `@ts-nocheck` from pure-logic modules
All new files in this codebase use `// @ts-nocheck` per the project convention. The reviewer flagged this as the main maintainability concern. Highest-leverage cleanup targets:
- `src/lib/delivery/*.ts` (pure FFmpeg/channel logic)
- `src/lib/studio-knowledge/*.ts` (pure summarization logic)
- `src/lib/rag/*.ts` (pure embedding/query logic)
- `kit-render-worker/src/ffmpeg/*.ts`

### G2. Delivery progress messages don't auto-refresh
Today the `processing` Slack message for a delivery job posts once and stays stale. Operators use `/kit deliver status` for live progress. Future polish: edit the original message in-place via `chat.update` every N%.

### G3. Slack email subject `Ranger &amp; Fox`
Slack's email template HTML-escapes the workspace name. You've decided to ignore — flagged so it doesn't get re-investigated.

### G4. Plaud MCP integration
Plaud exposes an MCP server with `list_files`, `get_transcript`, `get_note`. Could power ad-hoc Slack queries against past Plaud content without going through Kit's RAG. Deferred as a Phase 6 if/when there's a use case.

---

## H. Resync checkpoint (every 2-4 weeks)

Kit's projects + clients data drifts as Harvest changes. Recommended monthly:

```bash
cd C:\Users\studi\Kit
npx tsx scripts/backfill-projects-from-harvest.ts
npx tsx scripts/backfill-clients-from-harvest.ts
```

Both are idempotent. New projects + new contacts will be added; existing rows updated; embeddings refreshed.

(Long-term: convert to an Inngest weekly cron. Small follow-up.)

---

## Status snapshot

| Feature | State |
|---|---|
| Project provisioning | ✅ live |
| New-project intake card | ✅ live |
| Storyboards | ✅ live |
| Freelancer onboarding | ✅ live |
| Hours check-in (5pm) | ✅ live |
| Ad-hoc hours logging | ✅ live |
| Frame.io review detection | ✅ live |
| Studio knowledge (Q&A) | 🟡 needs A1 + A2 + A3 |
| Notes capture | 🟡 needs A1 (notes embed requires OpenAI) |
| Pre-meeting briefings | 🟡 needs C1-C5 |
| Plaud transcripts | 🔴 blocked on D1 (Plaud dev access) |
| Delivery pipeline | 🟡 needs A4 + A5 + E1-E5 |
| Auto-summarization (nightly) | 🟡 needs F1 |

When all 🟡 items resolve and Plaud lands, Kit is fully operational across the studio.
