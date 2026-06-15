// @ts-nocheck
/**
 * Email-keyed paperwork tracking (public.freelancer_paperwork).
 *
 * The source of truth for "have we worked with this freelancer before?".
 * Keyed on lowercased email because Connect-invited freelancers don't have a
 * Slack user id at onboarding time.
 */

import { createAdminClient } from '../../../../src/lib/supabase/admin'

export function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase()
}

export type PaperworkStatus = 'sent' | 'on_file' | 'waived'

export interface PaperworkRecord {
  email: string
  legal_name: string | null
  status: PaperworkStatus
  nda_sent_at: string | null
  nda_completed_at: string | null
}

/** Fetch the paperwork record for an email, or null if none exists. */
export async function getPaperwork(email: string): Promise<PaperworkRecord | null> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('freelancer_paperwork')
    .select('email, legal_name, status, nda_sent_at, nda_completed_at')
    .eq('email', normalizeEmail(email))
    .maybeSingle()
  if (error) {
    console.warn(`[nda] getPaperwork failed: ${error.message}`)
    return null
  }
  return (data as PaperworkRecord) || null
}

/**
 * Whether we should suppress (re)sending the NDA. True once paperwork has been
 * sent, confirmed on file, or waived — i.e. anything but a brand-new contact.
 */
export function hasPaperworkOnFile(rec: PaperworkRecord | null): boolean {
  if (!rec) return false
  return rec.status === 'sent' || rec.status === 'on_file' || rec.status === 'waived'
}

/** Record that an NDA was emailed (status=sent). Idempotent upsert by email. */
export async function recordNdaSent(opts: {
  email: string
  legalName: string | null
  onboardingId?: string | null
}): Promise<void> {
  const sb = createAdminClient()
  const now = new Date().toISOString()
  const { error } = await sb.from('freelancer_paperwork').upsert(
    {
      email: normalizeEmail(opts.email),
      legal_name: opts.legalName,
      status: 'sent',
      nda_sent_at: now,
      last_onboarding_id: opts.onboardingId || null,
      updated_at: now,
    },
    { onConflict: 'email' },
  )
  if (error) console.warn(`[nda] recordNdaSent failed: ${error.message}`)
}

/** Mark a freelancer's signed paperwork as received (status=on_file). */
export async function markPaperworkOnFile(opts: {
  email: string
  completedBy: string
}): Promise<boolean> {
  const sb = createAdminClient()
  const now = new Date().toISOString()
  const { error } = await sb
    .from('freelancer_paperwork')
    .update({
      status: 'on_file',
      nda_completed_at: now,
      nda_completed_by: opts.completedBy,
      updated_at: now,
    })
    .eq('email', normalizeEmail(opts.email))
  if (error) {
    console.warn(`[nda] markPaperworkOnFile failed: ${error.message}`)
    return false
  }
  return true
}
