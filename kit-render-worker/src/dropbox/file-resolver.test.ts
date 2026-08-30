import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolvePathUnderRoot } from './path-safety'

describe('Dropbox local path containment', () => {
  const root = path.resolve('/safe/dropbox')

  it('maps a normal Dropbox path beneath the configured root', () => {
    assert.equal(
      resolvePathUnderRoot(root, '/production/2026/project/file.mov'),
      path.join(root, 'production', '2026', 'project', 'file.mov'),
    )
  })

  it('rejects traversal, UNC, drive, and relative inputs', () => {
    for (const value of [
      '/../secret',
      '/production/../../secret',
      '\\\\server\\share\\file.mov',
      '/C:/Windows/file.mov',
      'production/file.mov',
    ]) assert.equal(resolvePathUnderRoot(root, value), null)
  })
})
