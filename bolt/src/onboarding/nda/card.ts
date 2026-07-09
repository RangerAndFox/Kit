// @ts-nocheck
/**
 * NDA confirmation card + modal.
 *
 * During onboarding, Kit posts a card per first-time freelancer. The operator
 * clicks "Review & send NDA", which opens a modal where they pick the NDA type
 * (Individual / Company), confirm the company name + agreement date, and send.
 * The modal submission fills + (for Company) converts to PDF + emails.
 */

export const NDA_REVIEW_ACTION = 'kit_nda_review'
export const NDA_SEND_CALLBACK = 'kit_nda_send'

export interface NdaCardContext {
  artistEmail: string
  artistName: string
  /** Legal/entity name captured at onboarding (prefills the Company field). */
  legalName?: string | null
  onboardingId?: string | null
  /** Channel/user to post the confirmation back to. */
  channel: string
}

/** YYYY-MM-DD in the studio timezone, for the datepicker's initial_date. */
function todayYmd(date = new Date(), timeZone = 'America/Los_Angeles'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function typeOption(value: 'individual' | 'company') {
  const text =
    value === 'company' ? 'Company NDA (fills entity name + date)' : 'Individual NDA (sign-and-return PDF)'
  return { text: { type: 'plain_text', text }, value }
}

/** The message card with a single "Review & send NDA" button. */
export function buildNdaCardBlocks(ctx: NdaCardContext) {
  const suggested = (ctx.legalName || '').trim()
  const hint = suggested ? `Company NDA — *${suggested}*` : 'Individual NDA'
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `:lock: *NDA for ${ctx.artistName}* (${ctx.artistEmail})\n` +
          `Suggested: ${hint}. Review and send when ready.`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Review & send NDA' },
          action_id: NDA_REVIEW_ACTION,
          value: JSON.stringify(ctx),
        },
      ],
    },
  ]
}

/** The prefilled modal opened from the card button. */
export function buildNdaModalView(ctx: NdaCardContext, opts: { today?: Date } = {}) {
  const company = (ctx.legalName || '').trim()
  const defaultType: 'individual' | 'company' = company ? 'company' : 'individual'
  return {
    type: 'modal',
    callback_id: NDA_SEND_CALLBACK,
    private_metadata: JSON.stringify(ctx),
    title: { type: 'plain_text', text: 'Send NDA' },
    submit: { type: 'plain_text', text: 'Send NDA' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Sending to *${ctx.artistName}* — ${ctx.artistEmail}`,
        },
      },
      {
        type: 'input',
        block_id: 'nda_type',
        label: { type: 'plain_text', text: 'NDA type' },
        element: {
          type: 'radio_buttons',
          action_id: 'v',
          initial_option: typeOption(defaultType),
          options: [typeOption('individual'), typeOption('company')],
        },
      },
      {
        type: 'input',
        block_id: 'nda_company',
        optional: true,
        label: { type: 'plain_text', text: 'Company / legal entity (Company NDA only)' },
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          ...(company ? { initial_value: company } : {}),
          placeholder: { type: 'plain_text', text: 'e.g. Jane Doe Creative LLC' },
        },
      },
      {
        type: 'input',
        block_id: 'nda_date',
        label: { type: 'plain_text', text: 'Agreement date (Company NDA)' },
        element: {
          type: 'datepicker',
          action_id: 'v',
          initial_date: todayYmd(opts.today),
        },
      },
    ],
  }
}

/** Decode the card/modal context. */
export function parseNdaContext(raw: string): NdaCardContext | null {
  try {
    const c = JSON.parse(raw)
    if (c && c.artistEmail && c.artistName) return c
  } catch {
    /* fall through */
  }
  return null
}

/** Read the modal submission state into { ndaType, company, date }. */
export function parseNdaModalSubmission(view: any): {
  ndaType: 'individual' | 'company'
  company: string
  date: Date
} {
  const v = view?.state?.values || {}
  const ndaType =
    v.nda_type?.v?.selected_option?.value === 'company' ? 'company' : 'individual'
  const company = (v.nda_company?.v?.value || '').trim()
  const ymd = v.nda_date?.v?.selected_date // YYYY-MM-DD
  // Parse the picked date at noon UTC so timezone formatting can't roll it.
  const date = ymd ? new Date(`${ymd}T12:00:00Z`) : new Date()
  return { ndaType, company, date }
}
