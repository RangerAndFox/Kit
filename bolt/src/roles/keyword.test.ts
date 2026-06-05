/**
 * Run: npx tsx --test bolt/src/roles/keyword.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseRoleIntent } from './keyword'

describe('parseRoleIntent', () => {
  it('"make @U a producer"', () => {
    assert.deepEqual(parseRoleIntent('make <@U123> a producer'), {
      targetSlackId: 'U123',
      role: 'producer',
      isQuery: false,
    })
  })

  it('"set @U role to producer"', () => {
    const r = parseRoleIntent("set <@U123|ally>'s role to producer")
    assert.equal(r?.role, 'producer')
    assert.equal(r?.targetSlackId, 'U123')
  })

  it('"give @U admin access" → founder', () => {
    assert.equal(parseRoleIntent('give <@U9> admin access')?.role, 'founder')
  })

  it('"promote @U to artist"', () => {
    assert.equal(parseRoleIntent('promote <@U9> to artist')?.role, 'artist')
  })

  it('literal "/kit role @U producer"', () => {
    assert.equal(parseRoleIntent('/kit role <@U9> producer')?.role, 'producer')
  })

  it('"@U role" → query', () => {
    assert.deepEqual(parseRoleIntent('<@U9> role'), { targetSlackId: 'U9', role: null, isQuery: true })
  })

  it("\"what's @U's role\" → query", () => {
    const r = parseRoleIntent("what's <@U9>'s role?")
    assert.equal(r?.isQuery, true)
  })

  it('no mention → null', () => {
    assert.equal(parseRoleIntent('make Allyson a producer'), null)
  })

  it('unrelated message with a mention → null', () => {
    assert.equal(parseRoleIntent('hey <@U9> can you review the cut?'), null)
  })

  it('mention + role word but no intent verb → null (avoid false positive)', () => {
    // "the producer <@U9> sent notes" — mentions a producer but isn't a role change
    assert.equal(parseRoleIntent('the producer <@U9> sent notes'), null)
  })
})
