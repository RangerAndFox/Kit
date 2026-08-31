import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dropboxDirname, sanitizeName } from '../aerender/path-utils'

describe('AE shared output paths', () => {
  it('uses the Dropbox project directory for POSIX and Windows separators', () => {
    assert.equal(dropboxDirname('/2026/2659 Project/04_Project Files/edit.aep'), '/2026/2659 Project/04_Project Files')
    assert.equal(dropboxDirname('\\2026\\2659 Project\\edit.aep'), '/2026/2659 Project')
  })

  it('replaces filesystem control characters and supplies a safe fallback', () => {
    assert.equal(sanitizeName('Boardomatic:V2/Client*'), 'Boardomatic_V2_Client_')
    assert.equal(sanitizeName('   '), 'comp')
  })
})
