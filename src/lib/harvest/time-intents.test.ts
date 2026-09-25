import { it } from 'node:test'
import assert from 'node:assert/strict'
import { guardedTimeWrite, type TimeIntentStore } from './time-intents'

function fixture() {
  let held = false
  let receipt: { id: number } | null = null
  let posts = 0
  const store: TimeIntentStore = {
    claim: async () => { if (held) return false; held = true; return true },
    commit: async () => {}, reconcile: async () => { held = true }, reject: async () => { held = false },
  }
  const io = { store, lookup: async () => receipt, post: async () => { posts++; receipt = { id: 123 }; return receipt }, definitelyRejected: () => false }
  return { io, posts: () => posts, held: () => held, save: () => { receipt = { id: 123 } } }
}

it('two concurrent confirmations and a later retry can only create one entry', async () => {
  const f = fixture()
  await Promise.allSettled([guardedTimeWrite(f.io), guardedTimeWrite(f.io)])
  const retry = await guardedTimeWrite(f.io)
  assert.equal(f.posts(), 1)
  assert.equal(retry.id, 123)
  assert.equal(retry.reused, true)
})
it('a timed-out POST that committed is reconciled, never posted again', async () => {
  const f = fixture()
  let calls = 0
  f.io.post = async () => { calls++; f.save(); throw new Error('timeout') }
  assert.equal((await guardedTimeWrite(f.io)).reused, true)
  assert.equal((await guardedTimeWrite(f.io)).id, 123)
  assert.equal(calls, 1)
})
it('unknown outcomes retain their durable hold; an outage is not absence', async () => {
  const f = fixture()
  let calls = 0
  f.io.post = async () => { calls++; throw new Error('timeout') }
  await assert.rejects(guardedTimeWrite(f.io), /timeout/)
  await assert.rejects(guardedTimeWrite(f.io), /unconfirmed Harvest outcome/)
  assert.equal(f.held(), true)
  assert.equal(calls, 1)
})
it('preflight read failure prevents a claim or POST', async () => {
  const f = fixture()
  f.io.lookup = async () => { throw new Error('read outage') }
  await assert.rejects(guardedTimeWrite(f.io), /read outage/)
  assert.equal(f.held(), false)
  assert.equal(f.posts(), 0)
})
it('a definitive rejection can be corrected and safely retried', async () => {
  const f = fixture()
  const post = f.io.post
  f.io.post = async () => { throw new Error('422 validation') }
  f.io.definitelyRejected = () => true
  await assert.rejects(guardedTimeWrite(f.io), /422/)
  assert.equal(f.held(), false)
  f.io.post = post
  assert.equal((await guardedTimeWrite(f.io)).id, 123)
})
