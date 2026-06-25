// @ts-nocheck
/**
 * NDA onboarding step.
 *
 * Gated behind FREELANCER_PAPERWORK_ENABLED. On a freelancer's first onboarding
 * (no paperwork on file), Kit posts an NDA confirmation card. The operator
 * reviews it, picks the NDA type (Individual / Company), confirms the company
 * name + date, and sends — at which point sendNdaFromModal() fills the document,
 * converts the Company NDA to PDF, and emails it (cc'ing the studio).
 *
 * Returning freelancers (paperwork already on file) are skipped so they're
 * never re-carded.
 */

import type { App } from '@slack/bolt'
import { loadNdaPdf, fillCompanyNdaDocx } from './template'
import { sendGmailMessage } from './mailer'
import { convertDocxToPdf } from './pdf'
import { buildNdaCardBlocks, type NdaCardContext } from './card'
import {
  getPaperwork,
  hasPaperworkOnFile,
  recordNdaSent,
  normalizeEmail,
} from './paperwork'
import { createAdminClient } from '../../../../src/lib/supabase/admin'
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
 * Post an NDA confirmation card for a first-time freelancer. Never throws —
 * returns a ServiceResult the orchestrator records. The actual send happens
 * later, when the operator submits the modal (see sendNdaFromModal).
 */
export async function postNdaCardIfFirstTimer(opts: {
  app: App
  channel: string
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
  if (!process.env.ONBOARDING_FROM_EMAIL) {
    return { status: 'skipped', message: 'ONBOARDING_FROM_EMAIL not set; NDA card not posted.' }
  }
  if (!opts.channel) {
    return { status: 'skipped', message: 'No channel to post the NDA card to.' }
  }

  const email = normalizeEmail(opts.artistEmail)

  // First-timer check — don't re-card returning freelancers.
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

  const ctx: NdaCardContext = {
    artistEmail: opts.artistEmail,
    artistName: opts.artistName,
    legalName: opts.artistLegalName || null,
    onboardingId: opts.onboardingId || null,
    channel: opts.channel,
  }

  try {
    await opts.app.client.chat.postMessage({
      channel: opts.channel,
      text: `NDA ready to review for ${opts.artistName} (${opts.artistEmail}).`,
      blocks: buildNdaCardBlocks(ctx),
    })
    return { status: 'ok', message: `NDA card posted for ${opts.artistEmail}.` }
  } catch (err: any) {
    return { status: 'failed', message: err.message || String(err) }
  }
}

/**
 * Fill + send the NDA chosen in the modal. For Company NDAs the filled .docx is
 * converted to PDF via Drive before emailing. Records paperwork and updates the
 * onboarding tracking row. Never throws — returns a ServiceResult.
 */
export async function sendNdaFromModal(opts: {
  ndaType: 'individual' | 'company'
  company: string
  date: Date
  ctx: NdaCardContext
}): Promise<ServiceResult> {
  const { ctx } = opts
  const fromEmail = process.env.ONBOARDING_FROM_EMAIL
  if (!fromEmail) {
    return { status: 'failed', message: 'ONBOARDING_FROM_EMAIL not set; NDA not sent.' }
  }
  if (opts.ndaType === 'company' && !opts.company.trim()) {
    return { status: 'failed', message: 'Company NDA needs a legal entity name.' }
  }

  const email = normalizeEmail(ctx.artistEmail)
  const firstName = ctx.artistName.trim().split(/\s+/)[0] || 'there'
  const cc = ndaCcList()

  let attachment: { filename: string; content: Buffer; contentType: string }
  let recordName = ctx.artistName.trim()
  try {
    if (opts.ndaType === 'company') {
      const docx = fillCompanyNdaDocx({ company: opts.company.trim(), date: opts.date })
      const pdf = await convertDocxToPdf({
        docxBuffer: docx.buffer,
        name: docx.filename.replace(/\.docx$/i, ''),
        subject: fromEmail,
      })
      attachment = {
        filename: docx.filename.replace(/\.docx$/i, '.pdf'),
        content: pdf,
        contentType: 'application/pdf',
      }
      recordName = opts.company.trim()
    } else {
      const pdf = loadNdaPdf({ recipientName: ctx.artistName })
      attachment = { filename: pdf.filename, content: pdf.buffer, contentType: pdf.contentType }
    }

    await sendGmailMessage({
      from: fromEmail,
      to: ctx.artistEmail,
      cc,
      subject: 'Ranger & Fox NDA for signature',
      text: composeNdaEmailBody({ firstName }),
      attachments: [attachment],
    })
    await recordNdaSent({ email, legalName: recordName, onboardingId: ctx.onboardingId })

    // Mark the onboarding row as sent (best-effort).
    if (ctx.onboardingId) {
      try {
        await createAdminClient()
          .from('freelancer_onboardings')
          .update({ nda_status: 'sent', nda_sent_at: new Date().toISOString() })
          .eq('id', ctx.onboardingId)
      } catch {
        /* tracking update is non-fatal */
      }
    }

    const label = opts.ndaType === 'company' ? `Company NDA (${recordName})` : 'Individual NDA'
    return {
      status: 'ok',
      message: `${label} emailed to ${ctx.artistEmail}${cc.length ? ` (cc ${cc.join(', ')})` : ''}.`,
    }
  } catch (err: any) {
    return { status: 'failed', message: err.message || String(err) }
  }
}
