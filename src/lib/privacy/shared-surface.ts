/**
 * Fail-closed privacy filters for Slack surfaces that may include artists or
 * other broad channel membership. These are deterministic on purpose: a model
 * instruction is useful context, but it is not an access-control boundary.
 */

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/
const MONEY_RE = /(?:[$€£]\s?\d|\b\d[\d,.]*\s?(?:usd|dollars?|bucks?)\b)/i
const FINANCIAL_RE = /\b(?:budget|rate(?:s| card)?|costs?|revenue|margin|invoice|payment|fee|estimate|quote|profit|salary|compensation|purchase order|po number)\b/i
const CONTACT_RE = /\b(?:client contact|contact info(?:rmation)?|email address|phone number|mobile number|reach (?:him|her|them|me) at)\b/i
const SECRET_RE = /\b(?:password|passcode|credential|api key|access token|refresh token|secret key|bank account|routing number|social security|ssn)\b/i
const PRIVATE_RE = /\b(?:confidential|private conversation|personal matter|medical|health information|attorney|legal advice|internal[- ]only)\b/i
const CONTRACT_RE = /\b(?:contract|statement of work|\bSOW\b|nda terms?)\b/i

export function containsSharedSurfaceSensitiveContent(text: string): boolean {
  const value = String(text || '')
  return [EMAIL_RE, PHONE_RE, MONEY_RE, FINANCIAL_RE, CONTACT_RE, SECRET_RE, PRIVATE_RE, CONTRACT_RE]
    .some((pattern) => pattern.test(value))
}

/**
 * Build a conservative project-safe transcript derivative. The full source is
 * retained separately for admins. Lines with financial, contact, credential,
 * contractual, personal, or private material are omitted entirely. Speaker
 * names are also removed so a transcript cannot become a client-contact list.
 */
export function sanitizeTranscriptForSharedSurface(text: string): string {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !containsSharedSurfaceSensitiveContent(line))
    .filter((line) => !/https?:\/\//i.test(line))
    .map((line) => line.replace(/^(\[[^\]]+\]\s*)?[^:\n]{1,80}:\s*/, (_match, time = '') => `${time}Speaker: `))
    .join('\n')
    .trim()
}

/** Remove restricted lines from broader shared-channel context. */
export function sanitizeSharedContext(text: string): string {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !containsSharedSurfaceSensitiveContent(line))
    .join('\n')
    .trim()
}

export const SHARED_CHANNEL_PRIVACY_REPLY =
  "I can’t share financial, client-contact, transcript-private, or other sensitive details in a shared channel. Ask me in a private DM; your Kit access level will still be enforced there."

/** Final output boundary for any non-DM Slack reply. */
export function guardSharedSlackReply(text: string): string {
  return containsSharedSurfaceSensitiveContent(text) ? SHARED_CHANNEL_PRIVACY_REPLY : text
}
