import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { harvestProjectWebUrl, harvestWebBaseUrl } from './web-url'

const original = process.env.HARVEST_WEB_BASE_URL

afterEach(() => {
  if (original === undefined) delete process.env.HARVEST_WEB_BASE_URL
  else process.env.HARVEST_WEB_BASE_URL = original
})

describe('Harvest browser URLs', () => {
  it('uses the current Ranger & Fox Harvest subdomain by default', () => {
    delete process.env.HARVEST_WEB_BASE_URL
    assert.equal(harvestProjectWebUrl(49058014), 'https://rangerfox.harvestapp.com/projects/49058014')
  })

  it('accepts a validated Harvest account base for future account renames', () => {
    process.env.HARVEST_WEB_BASE_URL = 'https://example.harvestapp.com/'
    assert.equal(harvestWebBaseUrl(), 'https://example.harvestapp.com')
  })

  it('fails closed to the known account for non-Harvest hosts', () => {
    process.env.HARVEST_WEB_BASE_URL = 'https://example.com'
    assert.equal(harvestWebBaseUrl(), 'https://rangerfox.harvestapp.com')
  })
})
