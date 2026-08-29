import { describe, expect, it } from 'vitest'
import {
  dashboardBaseUrl,
  KIT_PRODUCTION_DASHBOARD_URL,
} from '../src/handlers/dashboard-card'

describe('dashboardBaseUrl', () => {
  it('uses Kit’s verified production address when Railway has no URL variable', () => {
    expect(dashboardBaseUrl({} as NodeJS.ProcessEnv)).toBe(KIT_PRODUCTION_DASHBOARD_URL)
  })

  it('prefers a valid configured dashboard URL and removes its trailing slash', () => {
    expect(dashboardBaseUrl({ KIT_DASHBOARD_URL: 'https://kit.example.com/' } as NodeJS.ProcessEnv))
      .toBe('https://kit.example.com')
  })

  it('ignores malformed and insecure remote overrides', () => {
    expect(dashboardBaseUrl({ KIT_DASHBOARD_URL: 'not a URL' } as NodeJS.ProcessEnv))
      .toBe(KIT_PRODUCTION_DASHBOARD_URL)
    expect(dashboardBaseUrl({ KIT_DASHBOARD_URL: 'http://example.com' } as NodeJS.ProcessEnv))
      .toBe(KIT_PRODUCTION_DASHBOARD_URL)
  })
})
