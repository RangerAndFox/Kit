// @ts-nocheck
/**
 * NDA onboarding step.
 *
 * Gated behind FREELANCER_PAPERWORK_ENABLED. On a freelancer's first onboarding
 * (no paperwork on file for their email), fills the R&F NDA with their details
 * and emails it for signature, cc'ing the studio (Jared by default). Returning
 * freelancers are skipped so they're never double-emailed.
 */

import { loadNdaPdf } from './template'
import { sendGmailMessage } from './mailer'
import {
  getPaperwork,
  hasPaperworkOnFile,
  recordNdaSent,
  normalizeEmail,
} from './paperwork'
import type { ServiceResult } from '../types'

const DEFAULT_CC = 'jared@rangerandfox.tv'

export function ndaEnabled(): boolean {
  return process.env.FREELANCER_PAPERWORK_ENABLED === 'true'
}

export function ndaCcList(): string[] {
  const raw = process.env.ONBOARDING_NDA_CC || DEFAULT_CC
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

export function composeNdaEmailBody(opts: { firstName: string }): string {
  return [
    `Hi ${opts.firstName},`,
    '',
    `Welcome aboard — we're glad to be working with you at Ranger & Fox.`,
    '',
    `Before we get rolling, please review and sign the attached Non-Disclosure ` +
      `Agreement. Just add your signature, print your name, date it, and send it ` +
      `back to us.`,
    '',
    `If anything looks off or you have any questions, reply to this email and we'll sort it out.`,
    '',
    `Thanks,`,
    `Ranger & Fox`,
  ].join('\n')
}

/**
 * Send the NDA to a first-time freelancer. Never throws — returns a
 * ServiceResult the orchestrator records alongside the other invites.
 */
export async function sendNdaIfFirstTimer(opts: {
  artistEmail: string
  artistName: string
  artistLegalName?: string | null
  onboardingId?: string | null
}): Promise<ServiceResult> {
  if (!ndaEnabled()) {
    return {
      status: 'skipped',
      message: 'NDA paperwork disabled (FREELANCER_PAPERWORK_ENABLED not set).',
    }
  }
  const fromEmail = process.env.ONBOARDING_FROM_EMAIL
  if (!fromEmail) {
    return { status: 'skipped', message: 'ONBOARDING_FROM_EMAIL not set; NDA not sent.' }
  }

  const email = normalizeEmail(opts.artistEmail)

  // First-timer check — don't re-send to returning freelancers.
  try {
    const existing = await getPaperwork(email)
    if (hasPaperworkOnFile(existing)) {
      const label =
        existing?.status === 'on_file'
          ? 'on file'
          : existing?.status === 'waived'
            ? 'waived'
            : 'already sent'
      return { status: 'skipped', message: `Paperwork ${label} for ${email}; NDA not re-sent.` }
    }
  } catch (err: any) {
    return { status: 'failed', message: `paperwork lookup failed: ${err.message || err}` }
  }

  // Name we record this send under: legal name if captured, else display name.
  const recordName = (opts.artistLegalName || '').trim() || opts.artistName.trim()
  const firstName = opts.artistName.trim().split(/\s+/)[0] || 'there'
  const cc = ndaCcList()

  try {
    const nda = loadNdaPdf({ recipientName: opts.artistName })

    await sendGmailMessage({
      from: fromEmail,
      to: opts.artistEmail,
      cc,
      subject: 'Ranger & Fox NDA for signature',
      text: composeNdaEmailBody({ firstName }),
      attachments: [
        { filename: nda.filename, content: nda.buffer, contentType: nda.contentType },
      ],
    })
    await recordNdaSent({ email, legalName: recordName, onboardingId: opts.onboardingId })
    return {
      status: 'ok',
      message: `NDA emailed to ${opts.artistEmail}${cc.length ? ` (cc ${cc.join(', ')})` : ''}.`,
    }
  } catch (err: any) {
    return { status: 'failed', message: err.message || String(err) }
  }
}
