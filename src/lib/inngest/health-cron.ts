// @ts-nocheck
/**
 * Health watchdog — Inngest cron.
 *
 * Every 10 min: run all health checks, compare against the last recorded
 * state, and post to the ops channel ONLY when something flips (down or
 * recovered). Persists the new state so a persistent outage alerts once, not
 * every tick. This is the piece that would have paged us the day Dropbox's
 * token went missing instead of three months later.
 *
 * Silent no-op if KIT_HEALTH_CHANNEL_ID / SLACK_BOT_TOKEN aren't set — the
 * checks still run and persist, so /status stays accurate without alerts.
 */

import { inngest } from './client'
import { runAllChecks } from '../health/run'
import { loadHealthRows, statusMap, saveHealthState } from '../health/state'
import { diffHealth } from '../health/diff'

async function postSlack(channel: string, text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token || !channel) return
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, text, mrkdwn: true }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null)
}

export const healthWatchdog = inngest.createFunction(
  {
    id: 'health-watchdog',
    name: 'Health — watchdog + alerts',
    retries: 1,
    triggers: [{ cron: '*/10 * * * *' }],
  },
  async ({ step }) => {
    const results = await step.run('run-checks', () => runAllChecks())
    const prev = await step.run('load-state', () => loadHealthRows())

    const diff = diffHealth(statusMap(prev), results)

    if (diff.downed.length || diff.recovered.length) {
      await step.run('alert', async () => {
        const channel = process.env.KIT_HEALTH_CHANNEL_ID
        if (!channel) return
        const lines: string[] = []
        if (diff.downed.length) {
          lines.push(':rotating_light: *Kit health — something went down*')
          for (const d of diff.downed) lines.push(`:red_circle: *${d.label}* — ${d.detail || 'failing'}`)
        }
        if (diff.recovered.length) {
          for (const r of diff.recovered) lines.push(`:large_green_circle: *${r.label}* recovered`)
        }
        await postSlack(channel, lines.join('\n'))
      })
    }

    await step.run('save-state', () => saveHealthState(results, prev))

    return {
      checked: results.length,
      down: results.filter((r) => !r.ok).map((r) => r.key),
      alertedDown: diff.downed.length,
      alertedRecovered: diff.recovered.length,
    }
  },
)
