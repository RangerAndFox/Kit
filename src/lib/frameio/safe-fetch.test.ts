import { it } from 'node:test'
import assert from 'node:assert/strict'
import { frameioPublicUrl, fetchFrameioPublicUrl } from './safe-fetch'

it('rejects private IPs, credentials, lookalike hosts and insecure schemes before fetch', () => {
  for (const url of ['http://f.io/a', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://f.io.evil.test/a', 'https://evil.test/f.io/a', 'https://user:pass@f.io/a', 'https://f.io:8080/a']) assert.throws(() => frameioPublicUrl(url))
})

it('does not follow an untrusted redirect, including relative protocol redirects', async () => {
  for (const location of ['http://169.254.169.254/latest', '//evil.test/p', 'https://127.0.0.1/']) {
    let calls = 0
    const request: typeof fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location } }) }
    await assert.rejects(fetchFrameioPublicUrl('https://f.io/a', request))
    assert.equal(calls, 1)
  }
})

it('follows bounded provider redirects manually without credentials', async () => {
  const calls: string[] = []
  const request: typeof fetch = async (url, init) => {
    calls.push(String(url))
    assert.equal(init?.redirect, 'manual')
    assert.equal(init?.headers, undefined)
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://next.frame.io/reviews/123' } }) : new Response('ok')
  }
  assert.equal((await fetchFrameioPublicUrl('https://f.io/a', request)).url, 'https://next.frame.io/reviews/123')
  assert.equal(calls.length, 2)
  let loops = 0
  await assert.rejects(fetchFrameioPublicUrl('https://f.io/a', async () => { loops++; return new Response(null, { status: 302, headers: { location: '/a' } }) }))
  assert.equal(loops, 6)
})
