import { describe, expect, it } from 'vitest'
import { createSlackConnectionHealth } from '../src/slack-connection-health'

describe('real Slack connection health', () => {
  it('requires a hello handshake and active underlying socket', () => {
    let active = true
    const health = createSlackConnectionHealth(() => active, () => 100)
    expect(health.snapshot().connected).toBe(false)
    health.connected()
    expect(health.snapshot().connected).toBe(true)
    active = false // catches a socket loss even if no lifecycle event arrived
    expect(health.snapshot().connected).toBe(false)
  })
  it('lets SDK reconnects recover without extending an outage on each attempt', () => {
    let now = 0
    let active = true
    const health = createSlackConnectionHealth(() => active, () => now)
    health.connected()
    active = false
    health.disconnected()
    now = 60_000
    health.disconnected()
    expect(health.snapshot().restartRequired).toBe(false)
    now = 120_000
    expect(health.snapshot().restartRequired).toBe(true)
    expect(health.snapshot(true).restartRequired).toBe(false)
    active = true
    health.connected()
    expect(health.snapshot()).toMatchObject({ connected: true, unavailableMs: 0, restartRequired: false })
  })
  it('does not restart a quiet healthy connection, but detects startup failure', () => {
    let now = 0
    const health = createSlackConnectionHealth(() => true, () => now)
    now = 120_000
    expect(health.snapshot().restartRequired).toBe(true)
    health.connected()
    now = 86_400_000
    expect(health.snapshot().restartRequired).toBe(false)
  })
})
