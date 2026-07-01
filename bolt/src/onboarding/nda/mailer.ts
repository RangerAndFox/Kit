/**
 * Gmail sender for onboarding paperwork.
 *
 * Reuses the existing Google service account (GOOGLE_SERVICE_ACCOUNT_JSON,
 * already configured for the calendar integration). Gmail send requires the
 * service account to impersonate a real Workspace user via domain-wide
 * delegation — so the operator must (one-time) authorize the SA's client id
 * for the scope https://www.googleapis.com/auth/gmail.send and the message is
 * sent *as* ONBOARDING_FROM_EMAIL.
 *
 * Implemented with Node's built-in crypto + fetch rather than the heavy
 * `googleapis` package, which isn't installed in the Bolt/Railway image.
 */

import crypto from 'node:crypto'

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GMAIL_SEND_ENDPOINT =
  'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

export interface MailAttachment {
  filename: string
  content: Buffer
  contentType?: string
}

export interface ComposeOpts {
  /** The impersonated Workspace sender (also the delegation subject). */
  from: string
  to: string
  cc?: string[]
  subject: string
  text: string
  attachments?: MailAttachment[]
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** RFC 2047 encode a header value only if it contains non-ASCII characters. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/**
 * Build an RFC 2822 MIME message. Pure + deterministic except for the random
 * multipart boundary, so it's unit-testable without touching the network.
 */
export function buildMimeMessage(opts: ComposeOpts): string {
  const attachments = opts.attachments || []
  const headers: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
  ]
  if (opts.cc && opts.cc.length) headers.push(`Cc: ${opts.cc.join(', ')}`)
  headers.push(`Subject: ${encodeHeader(opts.subject)}`)
  headers.push('MIME-Version: 1.0')

  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset="UTF-8"')
    return `${headers.join('\r\n')}\r\n\r\n${opts.text}`
  }

  const boundary = `kit_nda_${crypto.randomBytes(12).toString('hex')}`
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)

  const lines: string[] = [headers.join('\r\n'), '']
  // Body text part.
  lines.push(`--${boundary}`)
  lines.push('Content-Type: text/plain; charset="UTF-8"')
  lines.push('')
  lines.push(opts.text)
  // Attachment parts.
  for (const a of attachments) {
    const encoded = a.content.toString('base64').replace(/(.{76})/g, '$1\r\n')
    lines.push(`--${boundary}`)
    lines.push(
      `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${a.filename}"`,
    )
    lines.push('Content-Transfer-Encoding: base64')
    lines.push(`Content-Disposition: attachment; filename="${a.filename}"`)
    lines.push('')
    lines.push(encoded)
  }
  lines.push(`--${boundary}--`)
  return lines.join('\r\n')
}

function getServiceAccountCreds(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set')
  // Allow raw JSON or base64-encoded JSON (env-friendly), matching the
  // calendar integration's convention.
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf-8')
  const creds = JSON.parse(json)
  if (!creds.client_email || !creds.private_key) {
    throw new Error('service account JSON missing client_email / private_key')
  }
  return creds
}

/**
 * Mint a domain-wide-delegated access token for `scope`, impersonating
 * `subject` (a real Workspace user). Shared by Gmail send and the Drive-based
 * Company-NDA docx→PDF conversion.
 */
export async function getDelegatedAccessToken(scope: string, subject: string): Promise<string> {
  const creds = getServiceAccountCreds()
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(
    JSON.stringify({
      iss: creds.client_email,
      scope,
      aud: TOKEN_ENDPOINT,
      sub: subject,
      iat: now,
      exp: now + 3600,
    }),
  )
  const signingInput = `${header}.${claim}`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), creds.private_key)
  const assertion = `${signingInput}.${b64url(signature)}`

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`)
  }
  const data: any = await res.json()
  if (!data.access_token) throw new Error('Google token exchange returned no access_token')
  return data.access_token as string
}

/** Mint a domain-wide-delegated access token for gmail.send as `subject`. */
async function getGmailAccessToken(subject: string): Promise<string> {
  return getDelegatedAccessToken(GMAIL_SEND_SCOPE, subject)
}

/** Send a message via the Gmail API. Returns the created message id. */
export async function sendGmailMessage(opts: ComposeOpts): Promise<{ id: string }> {
  const token = await getGmailAccessToken(opts.from)
  const raw = b64url(buildMimeMessage(opts))
  const res = await fetch(GMAIL_SEND_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw }),
  })
  if (!res.ok) {
    throw new Error(`Gmail send failed (${res.status}): ${await res.text()}`)
  }
  const data: any = await res.json()
  return { id: data.id }
}
