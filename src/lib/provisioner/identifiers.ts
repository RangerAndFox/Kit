/**
 * Single source of truth for the identity-derived strings Kit bakes into each
 * external service when a project is created: the project code, the Dropbox
 * folder safe-name, the Slack channel slug, and the Frame.io business label.
 *
 * These derivations were historically inlined at four call sites:
 *   - bolt/src/handlers/interactions.ts  (projectCode, dropboxSafeName)
 *   - src/lib/inngest/agents/dropbox.ts  (safeName)
 *   - src/lib/mcp/slack.ts               (channel slug base + short id)
 *   - src/lib/inngest/agents/frameio.ts  (businessLabel)
 *
 * The "update project" flow must recompute them identically when an identity
 * field (number / client / name) changes — otherwise a rename would target a
 * different string than create produced, and reconciliation-by-name would
 * break. Keeping one implementation guarantees create and update never diverge.
 *
 * Every function here is PURE and its output must remain byte-identical to the
 * original inline logic. `identifiers.test.ts` re-encodes the original
 * expressions as an oracle and asserts parity — do not "clean up" a regex here
 * without updating that guard.
 */

export interface ProjectIdentityInput {
  /** projects.id — stable across renames; only feeds the Slack short-id suffix. */
  projectId: string
  projectNumber: string
  client: string
  projectName: string
}

export interface ProjectIdentifiers {
  /** `${number}-${client without spaces}` — projects.project_code / Harvest code. */
  projectCode: string
  /** `{number}_{client}_{name}` sanitized — the `/production/{year}/{safeName}`
   *  leaf, persisted as external_ids.dropbox_safe_name. */
  dropboxSafeName: string
  /** Clean Slack channel slug, capped at Slack's 80-character limit. */
  slackSlugBase: string
  /** Stable 8-char id derived from projectId; used only for genuine collisions. */
  slackShortId: string
  /** Normal human-facing Slack channel slug (no internal id). */
  slackSlug: string
  /** Collision fallback `${truncatedBase}-${slackShortId}`. */
  slackCollisionSlug: string
  /** Frame.io business label `{number}_{client}_{name}` (join only, no sanitization). */
  frameioBusinessLabel: string
}

/**
 * Ranger & Fox project numbers encode the production year in their first two
 * digits: 2659 → 2026, 2701 → 2027. Letter suffixes after the four-digit spine
 * are allowed (for example 2630A). Returns null for legacy/non-standard values
 * so callers can retain an explicit, documented fallback.
 */
export function deriveProjectYear(projectNumber: string): string | null {
  const match = String(projectNumber ?? '').trim().match(/^(\d{2})\d{2}/)
  return match ? `20${match[1]}` : null
}

/** `${number}-${client}` with whitespace stripped from the client and TRIMMED off
 *  the number (plain_text_input never trims, and the preview shows the trimmed
 *  value — so an untrimmed number here would write a value the user never
 *  approved into projects.project_code and Harvest's live invoicing code).
 *  Mirrors the create-side `projectCode` in interactions.ts. */
export function deriveProjectCode(projectNumber: string, client: string): string {
  return `${String(projectNumber ?? '').trim()}-${client.replace(/\s+/g, '')}`
}

/** `{number}_{client}_{name}` sanitized. Mirrors the Dropbox agent's `safeName`
 *  and interactions.ts `dropboxSafeName` (identical output). */
export function deriveDropboxSafeName(
  projectNumber: string,
  client: string,
  projectName: string,
): string {
  return [projectNumber, client, projectName]
    .map((p) => (p ? String(p).trim() : ''))
    .filter(Boolean)
    .join('_')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
}

/** Frame.io business label `{number}_{client}_{name}` — join only, no sanitize.
 *  Mirrors the Frame.io agent's `businessLabel`. */
export function deriveFrameioBusinessLabel(
  projectNumber: string,
  client: string,
  projectName: string,
): string {
  return [projectNumber, client, projectName]
    .map((p) => (p ? String(p).trim() : ''))
    .filter(Boolean)
    .join('_')
}

/** Stable 8-char Slack short id from projectId. Mirrors slack.ts. */
export function deriveSlackShortId(projectId: string): string {
  return String(projectId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase()
}

/**
 * Human-facing Slack channel slug plus a deterministic collision fallback.
 * The normal slug never exposes Kit's internal project UUID. The suffixed form
 * is reserved for a genuine Slack `name_taken` collision.
 */
export function deriveSlackSlug(input: ProjectIdentityInput): {
  slackShortId: string
  slackSlugBase: string
  slackSlug: string
  slackCollisionSlug: string
} {
  const shortId = deriveSlackShortId(input.projectId)
  const base = [input.projectNumber, input.client, input.projectName]
    .filter((part) => part && String(part).trim())
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
  const collisionBase = shortId ? base.slice(0, 80 - (shortId.length + 1)).replace(/-$/g, '') : base
  const slackCollisionSlug = shortId ? `${collisionBase}-${shortId}` : base
  return {
    slackShortId: shortId,
    slackSlugBase: base,
    slackSlug: base,
    slackCollisionSlug,
  }
}

/** Derive every identity string at once. */
export function deriveProjectIdentifiers(input: ProjectIdentityInput): ProjectIdentifiers {
  const { slackShortId, slackSlugBase, slackSlug, slackCollisionSlug } = deriveSlackSlug(input)
  return {
    projectCode: deriveProjectCode(input.projectNumber, input.client),
    dropboxSafeName: deriveDropboxSafeName(input.projectNumber, input.client, input.projectName),
    slackSlugBase,
    slackShortId,
    slackSlug,
    slackCollisionSlug,
    frameioBusinessLabel: deriveFrameioBusinessLabel(
      input.projectNumber,
      input.client,
      input.projectName,
    ),
  }
}
