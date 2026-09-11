# Control-plane hardening — September 11, 2026

## Release requirements

- Next.js/eslint-config-next 16.3.4; sharp 0.35.4; js-yaml 4.3.2 in the lockfile.
- Apply migration `20260911151633_kit_control_outbox.sql` before releasing the application. It is already applied to the production database and verified with rollback-only tests.
- Keep preview Inngest registration disabled. The new `control-outbox-delivery` function must register on production; it runs every minute.
- All CI release checks must pass before merging. Do not bypass branch protection to release a failing build.

## Delivery and action semantics

Sync cron and edit-triggered sync share one concurrency group. Busy/lost workbook leases produce retryable failures, not successful no-ops. The ten-minute sweep remains the final recovery path.

`kit_control_outbox` holds service-only delivery state. An alert and its dedupe marker are saved in one transaction. The marker means queued, NOT delivered. Slack acknowledgement moves the queue record to sent. On a timeout/crash, the next attempt searches Slack message metadata before posting again. Unavailable or incomplete history never authorizes a blind resend; after bounded attempts, the item moves to review. The health check surfaces review/overdue items.

Control-center actions save their `kit_actions` audit and queue request atomically before dispatch. The response's requestId is both record IDs. Completion and the human-facing audit update together. A Behance retry's completed control action means the draft job was queued, not that a draft was saved or anything published. Errors stay retry/review; no false completion.

Inspect failed records through a restricted admin query. Do not edit payloads to bypass project/workspace validation. Do not mark alerts sent without a Slack receipt. Do not blindly clear send_started; it represents a potentially delivered message.

## MCP credentials

`createMcpToken` defaults to 30 days and accepts at most 90 days. Signed tokens lacking an expiry, expired tokens, and overlong tokens are rejected. Newly issued tokens include issuance time and an opaque token ID.

- Reissue any legacy non-expiring credentials before using those clients after this release. No production token values were retrieved or logged during this work; external client credentials cannot be inferred from repository code.
- Revoke one credential by adding its SHA-256 fingerprint (from `mcpTokenFingerprint`) to comma-separated `KIT_MCP_REVOKED_TOKEN_HASHES`. Never paste the token itself into logs or tickets. Deploy the environment update to make it effective.
- Set `KIT_MCP_NOT_BEFORE` to a Unix timestamp to reject tokens issued before it (including legacy tokens without issuance times).
- Rotate the signing secret via the deployment secret store and replace client tokens together. No permissive fallback signer or unbounded grace period is enabled.
- Renewal is an operator/client integration responsibility; this release does not invent a token refresh endpoint.

## Browser security

Proxy generates a fresh script nonce for each HTML request and forwards the policy to Next.js rendering. Production script-src has neither unsafe-inline nor unsafe-eval. Inline styles remain allowed for the existing Motion/UI styling. Root pages render dynamically; private/no-store responses prevent nonce reuse through page caching. API handlers retain their own authorization.

## Verification evidence

- Application tests: 836 passed. Bolt tests: 492 passed. Render worker: 6 passed. Browser worker: 14 passed. Worker/relay TypeScript builds passed.
- Root TypeScript and lint ratchet passed; existing baseline lint debt is not claimed eliminated.
- Node 22 production build passed. Local production login rendered and hydrated without browser errors; all page scripts carried nonces. Signed-out control-center access redirected to login. No email or OAuth submission was made in that local check.
- Live rollback-only database tests proved atomic action+queue persistence, exclusive claims, rejection of stale claim completion, atomic audit acknowledgement, alert dedupe, and denial of ordinary member/anonymous table and RPC access. No test rows survived.
- Post-migration security advisor: one informational notice for RLS enabled without client policies on the intentionally service-only outbox; no warning/error finding. Table privileges are explicitly revoked for anon/authenticated.
- Provider outage, ambiguous delivery, checkpoint failure, and permission-role scenarios use injected test doubles; no real provider outage or production upload was induced.

Authenticated producer/artist browser walkthroughs, external legacy MCP-client renewal, and an actual production Slack receipt for the new outbox still require direct post-release verification. Do not describe the local/rollback-only checks as complete live external end-to-end certification.
