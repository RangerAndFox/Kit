/**
 * Project naming spine — the single canonical project identifier used
 * across every layer of the system (Slack channel, Dropbox folder,
 * Frame.io project, Harvest project, Canvas titles, Supabase record).
 *
 * Per §3 of the Ranger & Fox Operations Blueprint, every project has
 * exactly one ID of the form:
 *
 *     [CLIENT-CODE]-[PROJECT#]-[SHORTNAME]
 *     e.g. MS-2612B-D365-CustomerService
 *
 * - CLIENT-CODE: short, uppercase alphanumeric (MS, GOOG, NRG, etc.)
 * - PROJECT#:    studio-internal job number, alphanumeric (2612B, 26-101)
 * - SHORTNAME:   PascalCase descriptor with hyphens between word groups
 *                (D365-CustomerService, Brand-Refresh-2026)
 *
 * The ID is the project's name in every external system. Display
 * strings ("Microsoft", "D365 Customer Service" with spaces) are
 * stored separately in the project record but never used as identifiers.
 */

export interface ProjectIdParts {
  clientCode: string
  projectNumber: string
  shortname: string
}

const SPINE_RE = /^[A-Z0-9]+-[A-Z0-9]+-[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/

/** Sanitise + assemble the four-part spine ID. */
export function formatProjectId(parts: ProjectIdParts): string {
  const clientCode = parts.clientCode.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const projectNumber = parts.projectNumber.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const shortname = parts.shortname
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!clientCode || !projectNumber || !shortname) {
    throw new Error(
      `formatProjectId: all three parts are required (got clientCode="${clientCode}", projectNumber="${projectNumber}", shortname="${shortname}")`
    )
  }
  return `${clientCode}-${projectNumber}-${shortname}`
}

/** True when `s` is a spine-formatted project ID. */
export function isProjectId(s: string | undefined | null): s is string {
  return typeof s === 'string' && SPINE_RE.test(s)
}

/**
 * Pull the three components back out of a spine ID. Returns null if the
 * string isn't a spine ID. The shortname keeps any internal hyphens.
 */
export function parseProjectId(id: string): ProjectIdParts | null {
  if (!isProjectId(id)) return null
  const m = id.match(/^([A-Z0-9]+)-([A-Z0-9]+)-(.+)$/)
  if (!m) return null
  return { clientCode: m[1], projectNumber: m[2], shortname: m[3] }
}

/**
 * Slack channel name for a project. Per §4 of the blueprint, project
 * channels use the `proj-` prefix. Slack channel names are lowercase
 * and capped at 80 chars.
 */
export function projectChannelName(projectId: string): string {
  return `proj-${projectId}`.toLowerCase().slice(0, 80)
}

/**
 * Folder/project name for systems that allow letters, digits, hyphens
 * (Dropbox, Frame.io, Harvest). Same as the spine ID, with any unsafe
 * characters scrubbed for safety.
 */
export function projectFolderName(projectId: string): string {
  return projectId.replace(/[^A-Za-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}
