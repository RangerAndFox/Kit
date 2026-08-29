import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { authRedirectBaseUrl, KIT_PRODUCTION_APP_URL } from './redirect-url'

describe('authRedirectBaseUrl', () => {
  it('never sends a production login back to localhost', () => {
    assert.equal(authRedirectBaseUrl({
      NODE_ENV: 'production',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    } as NodeJS.ProcessEnv), KIT_PRODUCTION_APP_URL)
  })

  it('uses Vercel’s stable production URL when available', () => {
    assert.equal(authRedirectBaseUrl({
      NODE_ENV: 'production',
      VERCEL_PROJECT_PRODUCTION_URL: 'kit.example.vercel.app',
    } as NodeJS.ProcessEnv), 'https://kit.example.vercel.app')
  })

  it('allows an explicit secure auth redirect override', () => {
    assert.equal(authRedirectBaseUrl({
      KIT_AUTH_REDIRECT_URL: 'https://kit.rangerandfox.tv/',
    } as unknown as NodeJS.ProcessEnv), 'https://kit.rangerandfox.tv')
  })
})
