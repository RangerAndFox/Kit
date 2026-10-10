// Shared allowlist for the team Overview and its comment reader. Keep financial
// links out of both surfaces. Root-folder types retain last-row-wins behavior;
// explicit documents/decks may have more than one row per project.
export const TEAM_ASSET_TYPES = ['Dropbox','Frame.io','Figma','Script','Boords','Client Visual Reference','Music Reference','ElevenLabs']
export const assetTypeKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '')
const allowed = new Set([...TEAM_ASSET_TYPES, 'OneDrive'].map(assetTypeKey))
const multiple = new Set(['figma', 'script', 'clientvisualreference', 'musicreference'])
export function teamAssetLinks(rows: Array<Record<string,string>>): Array<Record<string,string>> {
  const links = new Map<string,Record<string,string>>()
  for (const row of rows) {
    const type = assetTypeKey(row['Link Type'] || ''), url = row.URL?.trim()
    if (!allowed.has(type) || !url || String(row.Active || '').trim().toUpperCase() === 'FALSE') continue
    links.set(multiple.has(type) ? `${type}:${url}` : type, { ...row, URL: url })
  }
  return [...links.values()]
}
