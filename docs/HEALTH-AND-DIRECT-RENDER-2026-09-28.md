# Heartbeat reads and direct-to-Dropbox renders

## Evidence

- Production Vercel logged `heartbeat_read / timeout / elapsed_ms: 3007`
  at 2026-09-29 00:10 UTC. A single bounded database read failure was reported
  as “something went down”; it was not evidence that Railway jobs stopped.
- Project 2643's `R&F_CRM_Skills_Demo_V1.mp4` first appeared at 02:16 UTC
  as zero bytes, then as a 104,392,184-byte revision at 02:17:58. The previous
  five-minute deferral postponed upload until 02:23 and confirmation until
  02:29. The empty revision was superseded without upload. The current event
  completed normally; a read-only Frame.io GET independently confirmed
  `transcoded`, `video/mp4`, and the exact source byte count. No replay needed.

## Changes

- Retry a failed heartbeat read once after 250 ms, with a fresh independent
  three-second request. Never substitute stale cached success. Repeated read
  failure remains unknown; genuine job failures remain separately visible.
- Monitoring-only alerts now say “monitoring unavailable”, not that a job
  went down. Existing durable alert/state ordering and recovery remain intact.
- Source settling uses 60-second deferrals, without consuming the error retry
  budget. The existing 60-second quiet window is unchanged.
- New MP4/MOV/M4V uploads additionally require fully bounded movie/media atoms,
  a movie header with a positive known duration, and a track header. Truncated,
  missing, zero-size/open-ended, compressed or fragmented structures are held
  with an explicit reason, not optimistically uploaded.
- Header reads are bounded (at most 64 atoms, 1 KiB windows, 20-second shared
  deadline); nonzero ranges must be honored. Existing HTTPS/CDN allowlisting,
  redirect limit, MIME/byte-count checks and stream cancellation are retained.
- Re-read source identity/revision immediately before checkpoint/upload; an
  intervening revision change defers to the durable successor path.
- Poll accepted Frame.io transfers every minute for their first ten minutes,
  every two minutes until one hour, then every five minutes. Preserve the
  24-hour terminal bound, lease fencing, retirement guards and ready-before-
  share/notification rules. No new watcher, cursor, migration or credential.

## Limits and operations

A Dropbox cloud revision is not an OS file-close/renderer-completion signal.
Structural checks are conservative safeguards, not a decoder or proof of the
artist's intended final duration. Frame.io must still report exact bytes and
transcoded media before Kit announces it. A completed partial export can be
structurally valid. A definitive renderer completion guarantee would require
a renderer callback or an atomic move from a non-watched staging folder.

For unusual fragmented, compressed-movie or open-ended containers, export a
normal finalized MP4/MOV before placing it in the watched folder. Kit holds the
ambiguous source and eventually surfaces the existing 24-hour review timeout;
it never guesses that an indefinite recording has finished. Other formats
retain their prior stability/integrity gates. Expected start time is roughly
one to two minutes after Dropbox has synced a finalized revision, not after
the desktop renderer first creates its file; upload/transcoding takes longer.

## Verification and rollback

Focused tests cover interrupted containers, zero/unknown duration, extended
sizes, movie-at-start/end, range refusal, revision changes during inspection,
one-minute deferral without error-budget consumption, and heartbeat retry/
unknown/recovery. Full root/Bolt tests, typecheck, lint ratchet and webpack
production build are required before merge. Local default Turbopack cannot
follow this checkout's external dependency symlink; webpack is also the
repository's release-gate build. No build configuration changed.

Live Dropbox metadata and Frame.io asset state were checked, but the new
container reader was not exercised on this live source before deployment:
local diagnostic credentials do not include Dropbox access. Do not represent
unit tests as a live Dropbox range-contract test. Verify a subsequent new
normal render after deployment; never replay delivered media to test it.

Deploy the same commit to Vercel and Railway; verify both SHAs and fresh
successful monitor/inbox ticks. Rollback is a normal revert of this change;
no schema or data rollback is needed. Existing delivered/retired work stays
untouched.
