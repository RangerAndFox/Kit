import type { BehanceContentModule, BehanceManifest, BehanceTextRole } from './types.js'

const textRole = (value: unknown): BehanceTextRole =>
  value === 'title' || value === 'heading' || value === 'credits' ? value : 'description'

export function behanceContentModules(manifest: BehanceManifest): BehanceContentModule[] {
  if (Array.isArray(manifest.contentModules) && manifest.contentModules.length) {
    const allowedMedia = new Set(manifest.media)
    const modules: BehanceContentModule[] = []
    for (const module of manifest.contentModules) {
      if (module?.kind === 'text') {
        const text = String(module.text || '').trim()
        if (text) modules.push({ kind: 'text', role: textRole(module.role), text })
      }
      if (module?.kind === 'media') {
        const paths = [...new Set((module.paths || []).filter((item) => allowedMedia.has(item)))]
        if (paths.length) modules.push({ kind: 'media', paths })
      }
    }
    return modules
  }

  // Backward compatibility for packages queued before structured layout
  // shipped. This preserves every approved website-copy field without adding
  // labels or rewriting it.
  const [description1, description2, description3] = manifest.descriptions || []
  const main = manifest.media.filter((item) => !/\/Process\//i.test(item))
  const process = manifest.media.filter((item) => /\/Process\//i.test(item))
  const modules: BehanceContentModule[] = [
    { kind: 'text', role: 'title', text: [manifest.title, manifest.subtitle].filter(Boolean).join('\n') },
    ...(main[0] ? [{ kind: 'media' as const, paths: [main[0]] }] : []),
    ...(description1 ? [{ kind: 'text' as const, role: 'description' as const, text: description1 }] : []),
    ...(main.length > 1 ? [{ kind: 'media' as const, paths: main.slice(1) }] : []),
    ...(description2 ? [{ kind: 'text' as const, role: 'description' as const, text: description2 }] : []),
    ...(process.length ? [
      { kind: 'text' as const, role: 'heading' as const, text: 'Process' },
      { kind: 'media' as const, paths: process },
    ] : []),
    ...(description3 ? [{ kind: 'text' as const, role: 'description' as const, text: description3 }] : []),
    ...(manifest.credits ? [{ kind: 'text' as const, role: 'credits' as const, text: manifest.credits }] : []),
  ]
  return modules.filter((module) => module.kind !== 'text' || module.text.trim())
}
