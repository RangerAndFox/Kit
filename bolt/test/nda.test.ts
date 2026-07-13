import { describe, it, expect } from 'vitest'
import PizZip from 'pizzip'

import {
  loadNdaPdf,
  fillCompanyNdaDocx,
  formatNdaDateParts,
  NDA_PDF_PATH,
  NDA_COMPANY_TEMPLATE_PATH,
} from '../src/onboarding/nda/template'
import { buildMimeMessage } from '../src/onboarding/nda/mailer'
import {
  buildNdaCardBlocks,
  buildNdaModalView,
  parseNdaContext,
  parseNdaModalSubmission,
  NDA_REVIEW_ACTION,
  NDA_SEND_CALLBACK,
} from '../src/onboarding/nda/card'
import {
  hasPaperworkOnFile,
  normalizeEmail,
  type PaperworkRecord,
} from '../src/onboarding/nda/paperwork'
import {
  ndaCcList,
  composeNdaEmailBody,
  postNdaCardIfFirstTimer,
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
    // Normalize separators so the assertion holds on Windows too.
    expect(NDA_PDF_PATH.replace(/\\/g, '/')).toContain(
      'assets/nda/RF_One_Way_Individual_NDA.pdf',
    )
  })
})

describe('formatNdaDateParts', () => {
  it('formats day with ordinal, full month, and year in the studio tz', () => {
    const d = new Date('2026-06-15T20:00:00Z') // afternoon in LA
    expect(formatNdaDateParts(d, 'America/Los_Angeles')).toEqual({
      day: '15th',
      month: 'June',
      year: '2026',
    })
  })

  it('does not roll past midnight UTC (uses the studio tz)', () => {
    const d = new Date('2026-06-16T02:30:00Z') // still the 15th in LA
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

describe('fillCompanyNdaDocx', () => {
  it('fills [company]/[day]/[month]/[year] and leaves no bracket tags', () => {
    const { buffer, filename, contentType } = fillCompanyNdaDocx({
      company: 'Jane Doe Creative LLC',
      date: new Date('2026-06-15T20:00:00Z'),
    })
    expect(buffer.length).toBeGreaterThan(1000)
    expect(filename).toBe('NDA_RangerFox_Jane_Doe_Creative_LLC.docx')
    expect(contentType).toContain('wordprocessingml')

    const xml = new PizZip(buffer)
      .file('word/document.xml')!
      .asText()
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
    expect(xml).toContain('Jane Doe Creative LLC')
    expect(xml).toContain('made as of this 15th day of June 2026')
    // No unfilled placeholders remain.
    for (const tag of ['[company]', '[Company]', '[day]', '[month]', '[year]']) {
      expect(xml).not.toContain(tag)
    }
  })

  it('reads the committed company template path', () => {
    // Normalize separators so the assertion holds on Windows too.
    expect(NDA_COMPANY_TEMPLATE_PATH.replace(/\\/g, '/')).toContain(
      'assets/nda/RF_One_Way_Company_NDA.template.docx',
    )
  })
})

describe('NDA card + modal', () => {
  const ctx = {
    artistEmail: 'jane@artist.com',
    artistName: 'Jane Doe',
    legalName: 'Jane Doe Creative LLC',
    onboardingId: 'ob-123',
    channel: 'U999',
  }

  it('card button carries the context as JSON and the review action id', () => {
    const blocks = buildNdaCardBlocks(ctx)
    const btn = blocks.find((b: any) => b.type === 'actions')!.elements[0]
    expect(btn.action_id).toBe(NDA_REVIEW_ACTION)
    expect(parseNdaContext(btn.value)).toEqual(ctx)
  })

  it('modal defaults to Company when a legal name is present and prefills it', () => {
    const view = buildNdaModalView(ctx, { today: new Date('2026-06-25T20:00:00Z') })
    expect(view.callback_id).toBe(NDA_SEND_CALLBACK)
    expect(parseNdaContext(view.private_metadata)).toEqual(ctx)
    const typeBlock: any = view.blocks.find((b: any) => b.block_id === 'nda_type')
    expect(typeBlock.element.initial_option.value).toBe('company')
    const companyBlock: any = view.blocks.find((b: any) => b.block_id === 'nda_company')
    expect(companyBlock.element.initial_value).toBe('Jane Doe Creative LLC')
    const dateBlock: any = view.blocks.find((b: any) => b.block_id === 'nda_date')
    expect(dateBlock.element.initial_date).toBe('2026-06-25')
  })

  it('modal defaults to Individual when no legal name is present', () => {
    const view = buildNdaModalView({ ...ctx, legalName: null })
    const typeBlock: any = view.blocks.find((b: any) => b.block_id === 'nda_type')
    expect(typeBlock.element.initial_option.value).toBe('individual')
  })

  it('parses a modal submission into ndaType/company/date', () => {
    const submission = {
      state: {
        values: {
          nda_type: { v: { selected_option: { value: 'company' } } },
          nda_company: { v: { value: '  Acme Films LLC ' } },
          nda_date: { v: { selected_date: '2026-06-25' } },
        },
      },
    }
    const parsed = parseNdaModalSubmission(submission)
    expect(parsed.ndaType).toBe('company')
    expect(parsed.company).toBe('Acme Films LLC')
    expect(formatNdaDateParts(parsed.date, 'UTC')).toEqual({
      day: '25th',
      month: 'June',
      year: '2026',
    })
  })

  it('parseNdaContext rejects malformed / empty metadata', () => {
    expect(parseNdaContext('not json')).toBeNull()
    expect(parseNdaContext('{}')).toBeNull()
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
    const r = await postNdaCardIfFirstTimer({
      app: {} as any,
      channel: 'U1',
      artistEmail: 'a@b.com',
      artistName: 'A B',
    })
    expect(r.status).toBe('skipped')
    expect(r.message).toMatch(/disabled/i)
    if (prev !== undefined) process.env.FREELANCER_PAPERWORK_ENABLED = prev
  })

  it('skips when enabled but ONBOARDING_FROM_EMAIL is unset', async () => {
    const prevFlag = process.env.FREELANCER_PAPERWORK_ENABLED
    const prevFrom = process.env.ONBOARDING_FROM_EMAIL
    process.env.FREELANCER_PAPERWORK_ENABLED = 'true'
    delete process.env.ONBOARDING_FROM_EMAIL
    const r = await postNdaCardIfFirstTimer({
      app: {} as any,
      channel: 'U1',
      artistEmail: 'a@b.com',
      artistName: 'A B',
    })
    expect(r.status).toBe('skipped')
    expect(r.message).toMatch(/ONBOARDING_FROM_EMAIL/)
    if (prevFlag === undefined) delete process.env.FREELANCER_PAPERWORK_ENABLED
    else process.env.FREELANCER_PAPERWORK_ENABLED = prevFlag
    if (prevFrom !== undefined) process.env.ONBOARDING_FROM_EMAIL = prevFrom
  })
})
