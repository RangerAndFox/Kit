import { describe, it, expect } from 'vitest'
import PizZip from 'pizzip'

import {
  fillNdaTemplate,
  formatNdaDateParts,
  NDA_TEMPLATE_PATH,
} from '../src/onboarding/nda/template'
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

describe('formatNdaDateParts', () => {
  it('formats day with ordinal, full month, and year', () => {
    const d = new Date('2026-06-15T20:00:00Z') // afternoon in LA
    expect(formatNdaDateParts(d, 'America/Los_Angeles')).toEqual({
      day: '15th',
      month: 'June',
      year: '2026',
    })
  })

  it('uses the studio timezone (does not roll past midnight UTC)', () => {
    // 02:30 UTC on the 16th is still 19:30 on the 15th in LA.
    const d = new Date('2026-06-16T02:30:00Z')
    expect(formatNdaDateParts(d, 'America/Los_Angeles').day).toBe('15th')
  })

  it('handles 1st/2nd/3rd/21st ordinals', () => {
    const day = (iso: string) => formatNdaDateParts(new Date(iso), 'UTC').day
    expect(day('2026-06-01T12:00:00Z')).toBe('1st')
    expect(day('2026-06-02T12:00:00Z')).toBe('2nd')
    expect(day('2026-06-03T12:00:00Z')).toBe('3rd')
    expect(day('2026-06-21T12:00:00Z')).toBe('21st')
  })
})

describe('fillNdaTemplate', () => {
  it('merges company + date into the docx, preserves the letterhead logo', () => {
    const { buffer, filename, contentType } = fillNdaTemplate({
      companyName: 'Jane Doe Creative LLC',
      date: new Date('2026-06-15T20:00:00Z'),
    })
    expect(buffer.length).toBeGreaterThan(1000)
    expect(filename).toBe('NDA_RangerFox_Jane_Doe_Creative_LLC.docx')
    expect(contentType).toContain('wordprocessingml')

    const zip = new PizZip(buffer)
    // Collapse the XML to plain text (run boundaries become whitespace).
    const xml = zip
      .file('word/document.xml')!
      .asText()
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
    expect(xml).toContain('Jane Doe Creative LLC')
    expect(xml).toContain('made as of this 15th day of June 2026')
    // No unfilled merge tags or original blanks remain.
    expect(xml).not.toContain('{company_name}')
    expect(xml).not.toContain('2021')
    // Letterhead image survives the merge.
    expect(zip.file('word/media/image1.png')).toBeTruthy()
  })

  it('sanitizes the company name into a safe filename', () => {
    const { filename } = fillNdaTemplate({ companyName: 'José & Co. / Films' })
    expect(filename).toMatch(/^NDA_RangerFox_[\w]+\.docx$/)
  })

  it('reads the committed template path', () => {
    expect(NDA_TEMPLATE_PATH).toContain('assets/nda/RF_One_Way_Company_NDA.template.docx')
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

  it('composeNdaEmailBody greets by first name and names the company', () => {
    const body = composeNdaEmailBody({ firstName: 'Jane', companyName: 'Jane Doe LLC' })
    expect(body).toContain('Hi Jane,')
    expect(body).toContain('Jane Doe LLC')
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
