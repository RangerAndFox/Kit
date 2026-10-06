# Upload queue repair — 2026-10-06

## Mechanism and scope

The production health probe reported one arbitrary raw dead-letter error. Eight
unretired attempts existed: four missing Dropbox identities and four Frame.io
status-404 timeouts. Other deliveries continued completing, including 2640 on
October 6. This was not a general uploader outage.

Before-upload supersession already handled new revisions of the same Dropbox ID.
It did not handle delete/recreate (a new ID at the same path): metadata threw
before successor reconciliation. The fix uses the existing provider-specific
not-found reader, consults the old path only after definitive ID not-found, and
requires one nonretired durable successor for the live ID/revision, exact route
and same resolved Kit project. It uses the existing lease-fenced audit/completion
path with `superseded_before_upload`, never a fabricated ready transfer. Unproven
replacements, provider errors and lost leases remain unresolved. Existing
transfers still resume without depending on their old Dropbox source.

The health probe now counts the complete unretired dead-letter backlog and shows
three deterministically ordered project/file examples with sanitized reasons.
It remains red while any real unresolved attempt exists; it does not expose raw
provider responses, signed URLs or mention markup. Public liveness is unchanged.

## Approved production cleanup

Only these three pre-upload attempts were retired, atomically with append-only
`queue_disposition_audit` receipts and `operator_resolution` evidence. Their
statuses remain `dead_letter`, not delivered. Exact IDs, revisions, timestamps,
paths, project and absence of an old transfer were guarded in the transaction.
The identical transaction first passed with ROLLBACK.

| Retired event | Still-visible successor |
|---|---|
| b3831f94-ca34-477d-9bc5-efef29093ea9 | 9a1c2966-f765-4ba6-a886-13a3a480fea5 |
| f4e99564-4808-41fe-8f78-5007d8498699 | df696048-13bf-4b5d-b750-193b6dd3643d |
| ff532817-054a-4cd6-9abd-e7c9b84f2d82 | 961832de-a62c-44f0-a924-90e2113139df |

Dropbox live metadata confirmed all three old IDs absent and all three replacement
IDs/revisions/sizes at the same paths. The replacements are CCAI TTML/VTT/TXT
caption files. No file was deleted, uploaded, renamed or shared; no notification
was replayed. Audit and retired-row counts both verified at three; five unresolved
events remain. Future project uploads are unaffected.

## Remaining live verification

Railway browser authentication expired; GitHub Mobile approval is required to
use Kit's existing authenticated console without exporting credentials.
Do not reset or retry these five events based on database evidence alone:

- a634f881-119f-4c6d-b60d-9dd4b8f397b4: CCAI v3 video, Frame.io status 404.
- 9a1c2966-f765-4ba6-a886-13a3a480fea5: replacement TTML, Frame.io status 404.
- df696048-13bf-4b5d-b750-193b6dd3643d: replacement VTT, Frame.io status 404.
- 961832de-a62c-44f0-a924-90e2113139df: replacement TXT, Frame.io status 404.
- 4bb41f9f-834b-454e-98a6-1203b172f876: CCAI-named master in 2631 outgoing;
  source absent, no transfer. No exact replacement established.

## Validation

- Focused Bolt tests: 42 passed (replacement, auth failure, ambiguity, lease loss).
- Full Bolt suite: 1,051 passed; app suite: 937 passed.
- All three TypeScript configurations clean; lint ratchet passes.
- Node 22 production webpack build passes; migration integrity: 130 files.
- No migration or configuration change required. Release and live provider
  verification must be reported separately from these local checks.
