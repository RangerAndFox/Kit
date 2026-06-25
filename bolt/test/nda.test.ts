import { describe, it, expect } from 'vitest'

import { loadNdaPdf, NDA_PDF_PATH } from '../src/onboarding/nda/template'
import { buildMimeMessage } from '../src/onboarding/nda/mailer'
import {
  hasPaperworkOnFile,
  normalizeEmail,
  type PaperworkRecord,
} from '../src/onboarding/nda/paperwork'
import {
  ndaCcList,
  composeNdaEmailBody,
  sendNdaIfFirstTimer,
} from '../src/onboarding/nda/send'

describe('loadNdaPdf', () => {
  it('loads the committed NDA PDF with a pdf content type', () => {
    const { buffer, filename, contentType } = loadNdaPdf({ recipientName: 'Jane Doe' })
    expect(buffer.length).toBeGreaterThan(1000)
    // Real PDF bytes begin with "%PDF".
    expect(buffer.subarray(0, 4).toString('latin1')).toBe('%PDF')
    expect(contentType).toBe('application/pdf')
    expect(filename).toBe('NDA_RangerFox_Jane_Doe.pdf')
  })

  it('sanitizes the recipient name into a safe filename', () => {
    const { filename } = loadNdaPdf({ recipientName: 'José Q. Filmmaker / Co.' })
    expect(filename).toMatch(/^NDA_RangerFox_[\w]+\.pdf$/)
  })

  it('falls back to a generic filename when no recipient name is given', () => {
    expect(loadNdaPdf().filename).toBe('NDA_RangerFox.pdf')
  })

  it('reads the committed individual NDA path', () => {
    expect(NDA_PDF_PATH).toContain('assets/nda/RF_One_Way_Individual_NDA.pdf')
  })
})

describe('buildMimeMessage', () => {
  const attachment = {
    filename: 'NDA_RangerFox_Jane_Doe.docx',
    content: Buffer.from('fake-docx-bytes'),
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }

  it('builds a multipart message with headers, cc, and a base64 attachment', () => {
    const mime = buildMimeMessage({
      from: 'onboarding@rangerandfox.tv',
      to: 'jane@artist.com',
      cc: ['jared@rangerandfox.tv'],
      subject: 'Ranger & Fox NDA for signature',
      text: 'Hi Jane,\nPlease sign.',
      attachments: [attachment],
    })
    expect(mime).toContain('From: onboarding@rangerandfox.tv')
    expect(mime).toContain('To: jane@artist.com')
    expect(mime).toContain('Cc: jared@rangerandfox.tv')
    expect(mime).toContain('Subject: Ranger & Fox NDA for signature')
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="kit_nda_')
    expect(mime).toContain('Content-Disposition: attachment; filename="NDA_RangerFox_Jane_Doe.docx"')
    expect(mime).toContain(attachment.content.toString('base64'))
    expect(mime.trimEnd()).toMatch(/--kit_nda_[a-f0-9]+--$/)
  })

  it('RFC 2047-encodes a non-ASCII subject', () => {
    const mime = buildMimeMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'Café résumé',
      text: 'body',
    })
    expect(mime).toContain('Subject: =?UTF-8?B?')
    expect(mime).not.toContain('Subject: Café')
  })

  it('omits Cc when none given and is single-part without attachments', () => {
    const mime = buildMimeMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'Plain',
      text: 'just text',
    })
    expect(mime).not.toContain('Cc:')
    expect(mime).toContain('Content-Type: text/plain')
    expect(mime).not.toContain('multipart/mixed')
  })
})

describe('paperwork helpers', () => {
  const base: PaperworkRecord = {
    email: 'x@y.com',
    legal_name: null,
    status: 'sent',
    nda_sent_at: null,
    nda_completed_at: null,
  }

  it('normalizeEmail lowercases and trims', () => {
    expect(normalizeEmail('  Jane@Artist.COM ')).toBe('jane@artist.com')
  })

  it('hasPaperworkOnFile: null → false', () => {
    expect(hasPaperworkOnFile(null)).toBe(false)
  })

  it('hasPaperworkOnFile: sent / on_file / waived all suppress re-send', () => {
    expect(hasPaperworkOnFile({ ...base, status: 'sent' })).toBe(true)
    expect(hasPaperworkOnFile({ ...base, status: 'on_file' })).toBe(true)
    expect(hasPaperworkOnFile({ ...base, status: 'waived' })).toBe(true)
  })
})

describe('NDA send config + gating', () => {
  it('ndaCcList defaults to Jared, splits a custom list', () => {
    const prev = process.env.ONBOARDING_NDA_CC
    delete process.env.ONBOARDING_NDA_CC
    expect(ndaCcList()).toEqual(['jared@rangerandfox.tv'])
    process.env.ONBOARDING_NDA_CC = 'a@x.com, b@x.com'
    expect(ndaCcList()).toEqual(['a@x.com', 'b@x.com'])
    if (prev === undefined) delete process.env.ONBOARDING_NDA_CC
    else process.env.ONBOARDING_NDA_CC = prev
  })

  it('composeNdaEmailBody greets by first name and asks them to sign', () => {
    const body = composeNdaEmailBody({ firstName: 'Jane' })
    expect(body).toContain('Hi Jane,')
    expect(body).toMatch(/sign/i)
  })

  it('skips when the feature flag is off (no DB/network touched)', async () => {
    const prev = process.env.FREELANCER_PAPERWORK_ENABLED
    delete process.env.FREELANCER_PAPERWORK_ENABLED
    const r = await sendNdaIfFirstTimer({ artistEmail: 'a@b.com', artistName: 'A B' })
    expect(r.status).toBe('skipped')
    expect(r.message).toMatch(/disabled/i)
    if (prev !== undefined) process.env.FREELANCER_PAPERWORK_ENABLED = prev
  })

  it('skips when enabled but ONBOARDING_FROM_EMAIL is unset', async () => {
    const prevFlag = process.env.FREELANCER_PAPERWORK_ENABLED
    const prevFrom = process.env.ONBOARDING_FROM_EMAIL
    process.env.FREELANCER_PAPERWORK_ENABLED = 'true'
    delete process.env.ONBOARDING_FROM_EMAIL
    const r = await sendNdaIfFirstTimer({ artistEmail: 'a@b.com', artistName: 'A B' })
    expect(r.status).toBe('skipped')
    expect(r.message).toMatch(/ONBOARDING_FROM_EMAIL/)
    if (prevFlag === undefined) delete process.env.FREELANCER_PAPERWORK_ENABLED
    else process.env.FREELANCER_PAPERWORK_ENABLED = prevFlag
    if (prevFrom !== undefined) process.env.ONBOARDING_FROM_EMAIL = prevFrom
  })
})
