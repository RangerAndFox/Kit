# Historical delivery transfer evidence — corrected September 24, 2026

This replaces the earlier draft's unsupported “superseded = delivered” conclusions. Counts are snapshots, not live status or proof of delivery. No asset is certified delivered by this investigation.

## Independent read-only evidence

The later Codex database snapshot found **57 processing rows**, not the earlier 56: 2625=3, 2629=1, 2631=7, 2633=3, 2636=4, 2637=11, 2639=28. Normal live activity can change these counts.

- **2639:** upload-disabled setting remains authoritative. Preserve it; do not re-drive these 28 rows.
- **2637 / Fabric:** 11 historical processing rows. A ready sibling does not prove the old revision delivered. Owner-authorized retirement may apply to exact historical revisions without disabling future uploads.
- **2631:** the two supposedly superseding ready siblings were created about eight minutes **before** the processing rows, at different full revisions. They do not establish delivery or equivalence of the later revisions. Keep unresolved.
- **2625:** matching abbreviated revision prefixes concealed different full revisions. Prefixes are not identity.
- **2625 / 2629:** historic asset requests returned 404 while their project requests succeeded. This is unresolved provider evidence, **not** proof that a file was deleted, never delivered, or should be recreated.
- Recent 2631/2633/2636 records are not cleanup targets. Age alone is insufficient to judge playable media or successful delivery.

### Provider reads (read-only; no token refresh)

| Transfer or evidence | Observation | Safe conclusion |
|---|---|---|
| 2625 transfer 9527fca4-dafa-4d38-9afb-61c902cf1479 | Asset GET 404; project GET 200 | Unresolved |
| 2629 transfer 79e0504b-8cf4-4b39-b38f-8b66efeb0425 | Asset GET 404; project GET 200 | Unresolved |
| 2637 transfers 31eb1ac1-6436-47eb-a98f-0eb04211120a, be8d8e19-e985-48b4-936a-139b804b8f60, c9ca0d3c-6690-4969-a2e9-d8201e4687c1 | Asset GETs 404 | Not verified delivered |
| 2637 sibling 55176a2f-9e81-4b5b-a196-bac2d8ed6dc4 | Asset 200, transcoded, 49,670,526 bytes, matching identity/parent | Source revision byte-size evidence absent; no ledger correction |
| 2637 sibling fd0f0372-a11a-476f-99bc-f7d66d4e01f8 | Asset GET 404 | Not verified delivered |

No signed view/share URLs or credentials are recorded here. The 404 cases require source-revision and provider investigation before any repair upload is considered.

## Replay inventory

The later query restricted to frameio_delivery events by project safe-name prefix found:
- 2637: 68 complete, no retryable events.
- 2639: 28 complete, 34 dead-letter, uploads disabled.
- 2636: 5 complete, 2 dead-letter, 4 retryable.

The earlier “76 Fabric events” used a different, broader event scope. Neither count substitutes for the exact file-ID/revision/event-ID manifest checked at retirement time. Complete/dead-letter events are normally inert; retirement additionally guards future re-ingestion of the same historical revision.

## Dispositions

1. Preserve 2639's disabled setting.
2. Retire only explicitly selected historical Fabric revisions via the atomic, dry-run-default RPC and durable audit. Do not mark them ready, disable future Fabric uploads, delete files, or send historical Slack notifications.
3. Leave other historical unresolved records unchanged.
4. The stale-transfer reconciler is now **read-only**, including when the environment gate is enabled. Unknown identity, byte size, access, or completion stays unresolved. Write mode is rejected before any reads.
5. A positive candidate requires exact identity, exact source-revision size, completed media, and a share. Even that candidate is only a report; there is no automatic ledger mutation.

See KIT-FABRIC-RETIREMENT-AND-RECONCILER-2026-09-24.md for the executable retirement contract.
