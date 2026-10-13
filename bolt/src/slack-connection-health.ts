/** Observe the SDK's real socket, not auth.test (which only tests Web API access).
 * The SDK owns reconnects; restart only after a sustained outage. Quiet channels
 * are healthy: incoming business events are not a heartbeat. */
export function createSlackConnectionHealth(
  isActive: () => boolean,
  now: () => number = Date.now,
) {
  let handshake = false
  let unavailableSince: number | null = now()
  let lastConnectedAt: number | null = null
  return {
    connected() {
      handshake = true
      lastConnectedAt = now()
      unavailableSince = null
    },
    disconnected() {
      handshake = false
      unavailableSince ??= now()
    },
    snapshot(draining = false) {
      const connected = handshake && isActive()
      if (connected) unavailableSince = null
      else unavailableSince ??= now()
      const unavailableMs = unavailableSince === null ? 0 : now() - unavailableSince
      return {
        connected, lastConnectedAt, unavailableMs,
        restartRequired: !draining && !connected && unavailableMs >= 120_000,
      }
    },
  }
}
