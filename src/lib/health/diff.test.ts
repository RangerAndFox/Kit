/**
 * Health-diff unit tests — the "alert only on a flip" transition logic.
 *
 * Run: npx tsx --test src/lib/health/diff.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { diffHealth, type CheckResult } from './diff'

const r = (key: string, ok: boolean): CheckResult => ({ key, label: key, ok })

describe('diffHealth', () => {
  it('alerts when a previously-up check goes down', () => {
    const d = diffHealth({ dropbox: 'up' }, [r('dropbox', false)])
    assert.deepStrictEqual(d.downed.map((x) => x.key), ['dropbox'])
    assert.deepStrictEqual(d.recovered, [])
  })

  it('fires all-clear when a down check recovers', () => {
    const d = diffHealth({ dropbox: 'down' }, [r('dropbox', true)])
    assert.deepStrictEqual(d.recovered.map((x) => x.key), ['dropbox'])
    assert.deepStrictEqual(d.downed, [])
  })

  it('stays silent while a check is still down (no re-spam)', () => {
    const d = diffHealth({ dropbox: 'down' }, [r('dropbox', false)])
    assert.deepStrictEqual(d.downed, [])
    assert.deepStrictEqual(d.recovered, [])
  })

  it('stays silent while a check is still up', () => {
    const d = diffHealth({ dropbox: 'up' }, [r('dropbox', true)])
    assert.deepStrictEqual(d.downed, [])
    assert.deepStrictEqual(d.recovered, [])
  })

  it('treats an unknown (new) check as previously-up', () => {
    assert.deepStrictEqual(diffHealth({}, [r('new', false)]).downed.map((x) => x.key), ['new'])
    assert.deepStrictEqual(diffHealth({}, [r('new', true)]).downed, [])
  })

  it('handles a mixed batch', () => {
    const d = diffHealth(
      { dropbox: 'down', frameio: 'up', harvest: 'down' },
      [r('dropbox', true), r('frameio', false), r('harvest', false), r('supabase', true)],
    )
    assert.deepStrictEqual(d.recovered.map((x) => x.key), ['dropbox'])
    assert.deepStrictEqual(d.downed.map((x) => x.key), ['frameio'])
  })
})
