#!/usr/bin/env node
/**
 * One-time helper to obtain a Dropbox OAuth refresh token.
 *
 * Usage:
 *   1. Get App Key + App Secret from dropbox.com/developers/apps → your app
 *   2. Run: node scripts/dropbox-get-refresh-token.mjs
 *   3. Paste APP_KEY when prompted
 *   4. Visit the URL it prints, authorize, copy the auth code
 *   5. Paste APP_SECRET when prompted
 *   6. Paste the auth code when prompted
 *   7. Script prints the refresh token — save to Railway as DROPBOX_REFRESH_TOKEN
 *
 * Refresh tokens are long-lived (no expiry under normal use). You only do this once.
 */

import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const rl = readline.createInterface({ input, output })

async function ask(question) {
  return (await rl.question(question)).trim()
}

const appKey = await ask('Dropbox App Key: ')
if (!appKey) {
  console.error('App Key is required')
  process.exit(1)
}

const authUrl =
  `https://www.dropbox.com/oauth2/authorize` +
  `?client_id=${encodeURIComponent(appKey)}` +
  `&response_type=code` +
  `&token_access_type=offline`

console.log('\n1. Open this URL in your browser:\n')
console.log(`   ${authUrl}\n`)
console.log('2. Sign in if needed and click "Allow"')
console.log('3. Copy the access code shown on the next page\n')

const appSecret = await ask('Dropbox App Secret: ')
const code = await ask('Authorization code: ')

if (!appSecret || !code) {
  console.error('App Secret and authorization code are both required')
  process.exit(1)
}

const auth = Buffer.from(`${appKey}:${appSecret}`).toString('base64')
const body = new URLSearchParams({
  code,
  grant_type: 'authorization_code',
})

const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
  method: 'POST',
  headers: {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: body.toString(),
})

const data = await res.json()
if (!res.ok) {
  console.error('\nToken exchange failed:', data)
  process.exit(1)
}

console.log('\n✅ Success — set these in Railway → Variables:\n')
console.log(`  DROPBOX_APP_KEY       = ${appKey}`)
console.log(`  DROPBOX_APP_SECRET    = ${appSecret}`)
console.log(`  DROPBOX_REFRESH_TOKEN = ${data.refresh_token}`)
console.log('\n(You can DELETE the old DROPBOX_ACCESS_TOKEN once these are set.)\n')

rl.close()
