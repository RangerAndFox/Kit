import Anthropic from '@anthropic-ai/sdk'
import { createAdminClient } from '../supabase/admin'
import { readProjectSupplement } from '../project-control/sheets'
import { workbookConfigFromEnv } from '../project-control/types'
import type { ArchiveProjectSnapshot, ArchiveSettings } from './types'

const MODEL = 'claude-haiku-4-5-20251001'
const SENSITIVE_LINE = /\b(budget|cost|price|rate|fee|invoice|purchase order|\bpo\b|margin|profit|estimate|client contact|e-?mail|phone|address|password|credential|secret|token|api key|nda|legal|contract|confidential|internal only|not for publication)\b/i
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/
const MONEY = /(?:\$\s?\d|\b\d+(?:\.\d+)?\s?(?:usd|dollars?)\b)/i

export interface ArchiveCopyDraft extends Pick<ArchiveSettings,
  'title' | 'subtitle' | 'services' | 'description1' | 'description2' |
  'description3' | 'credits' | 'socialCopy' | 'excerpt'> {}

export function publicSafeContext(value: string, max = 12_000): string {
  return String(value || '')
    .split(/\r?\n/)
    .filter((line) => !SENSITIVE_LINE.test(line) && !EMAIL.test(line) && !PHONE.test(line) && !MONEY.test(line))
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, max)
}

const clip = (value: unknown, max: number) => String(value || '').trim().slice(0, max)
const unique = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))]

export function normalizeArchiveCopyDraft(raw: any, fallback: ArchiveCopyDraft): ArchiveCopyDraft {
  return {
    title: clip(raw?.title, 180) || fallback.title,
    subtitle: clip(raw?.subtitle, 240) || fallback.subtitle,
    services: unique(Array.isArray(raw?.services) ? raw.services.map(String) : fallback.services).slice(0, 12),
    description1: clip(raw?.description1, 2800) || fallback.description1,
    description2: clip(raw?.description2, 2800) || fallback.description2,
    description3: clip(raw?.description3, 2800) || fallback.description3,
    credits: clip(raw?.credits, 2800) || fallback.credits,
    socialCopy: clip(raw?.socialCopy, 2800) || fallback.socialCopy,
    excerpt: clip(raw?.excerpt, 900) || fallback.excerpt,
  }
}

function fallbackDraft(snapshot: ArchiveProjectSnapshot, brief: string, people: string[], roles: string[]): ArchiveCopyDraft {
  const safeBrief = publicSafeContext(brief, 1200)
  const intro = safeBrief || `${snapshot.client} partnered with Ranger & Fox on ${snapshot.projectName}.`
  const excerpt = intro.split(/(?<=[.!?])\s+/)[0].slice(0, 450)
  return {
    title: `${snapshot.client} | ${snapshot.projectName}`,
    subtitle: '',
    services: unique(roles.filter((role) => !/producer|client/i.test(role))),
    description1: intro,
    description2: '',
    description3: '',
    credits: people.join('\n'),
    socialCopy: `${intro}\n\nCreated by Ranger & Fox.`.slice(0, 2800),
    excerpt,
  }
}

async function gatherContext(workspaceId: string, snapshot: ArchiveProjectSnapshot): Promise<{
  project: any; sourceText: string; people: string[]; roles: string[]
}> {
  const sb = createAdminClient() as any
  const [{ data: project }, { data: docs }, { data: onboardings }] = await Promise.all([
    sb.from('projects').select('project_type,brief_summary,sow_summary,project_manager_slack_id').eq('id', snapshot.projectId).maybeSingle(),
    sb.from('project_documents')
      .select('title,content,doc_type,indexed_at')
      .eq('workspace_id', workspaceId)
      .eq('project_id', snapshot.projectId)
      // Raw notes can contain internal strategy with no obvious sensitive-data
      // keyword. Public-copy drafting only uses the team summary plus the
      // transcript derivative that already passed Kit's privacy redaction.
      .in('doc_type', ['project_summary', 'call_transcript_safe'])
      .order('indexed_at', { ascending: false })
      .limit(20),
    sb.from('freelancer_onboardings').select('artist_name').eq('project_id', snapshot.projectId),
  ])

  const people = (onboardings || []).map((row: any) => row.artist_name ? `Artist: ${row.artist_name}` : '').filter(Boolean)
  const roles: string[] = []
  if (project?.project_manager_slack_id) {
    const { data: producer } = await sb.from('staff').select('full_name,role').eq('slack_user_id', project.project_manager_slack_id).maybeSingle()
    if (producer?.full_name) people.unshift(`Producer: ${producer.full_name}`)
    if (producer?.role) roles.push(producer.role)
  }

  const config = workbookConfigFromEnv()
  if (config && snapshot.projectNumber) {
    try {
      const supplement = await readProjectSupplement(config, snapshot.projectNumber)
      for (const assignment of supplement.assignments || []) {
        if (assignment.Person) people.push(assignment.Role ? `${assignment.Role}: ${assignment.Person}` : assignment.Person)
        if (assignment.Role) roles.push(assignment.Role)
      }
      for (const item of supplement.workback || []) if (item.Phase) roles.push(item.Phase)
    } catch (error: any) {
      console.warn('[archive-copy] Project Control context unavailable:', error.message)
    }
  }

  const sourceText = publicSafeContext([
    project?.project_type && `Project type: ${project.project_type}`,
    project?.brief_summary && `Brief:\n${project.brief_summary}`,
    project?.sow_summary && `Scope summary:\n${project.sow_summary}`,
    ...(docs || []).map((doc: any) => `${doc.title || doc.doc_type}:\n${doc.content || ''}`),
  ].filter(Boolean).join('\n\n'))
  return { project, sourceText, people: unique(people), roles: unique(roles) }
}

export async function generateArchiveCopyDraft(workspaceId: string, snapshot: ArchiveProjectSnapshot): Promise<ArchiveCopyDraft> {
  const context = await gatherContext(workspaceId, snapshot)
  const fallback = fallbackDraft(snapshot, context.project?.brief_summary || '', context.people, context.roles)
  if (!process.env.ANTHROPIC_API_KEY || !context.sourceText) return fallback

  const prompt = `Draft public-facing portfolio and social copy for Ranger & Fox from the verified project context below.

Return ONLY valid JSON with exactly these keys:
{"title":"","subtitle":"","services":[],"description1":"","description2":"","description3":"","credits":"","socialCopy":"","excerpt":""}

Rules:
- Write polished, natural studio copy. Avoid generic hype and marketing clichés.
- Description 1 is a concise hero introduction. Description 2 explains the creative challenge and approach. Description 3 covers craft or outcome only when supported.
- Social copy should be a ready-to-edit post, not a list of notes. Do not add hashtags unless the context explicitly supports them.
- Never invent facts, outcomes, performance, awards, people, roles, services, or client approval.
- Never mention budgets, rates, schedules, deadlines, client contacts, email addresses, phone numbers, contracts, legal matters, credentials, private feedback, internal problems, or confidential information.
- Credits may use ONLY the verified credit candidates below. Preserve their supplied role labels. Do not include client contacts.
- If evidence is missing, use an empty string or empty array. The producer will review every field before draft creation.

Project: ${snapshot.projectNumber} — ${snapshot.client} — ${snapshot.projectName}
Verified credit candidates:
${context.people.map((person) => `- ${person}`).join('\n') || '- None verified'}

Possible service/discipline signals:
${context.roles.map((role) => `- ${role}`).join('\n') || '- None verified'}

Sanitized project context:
${context.sourceText}`

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30_000, maxRetries: 1 })
    const response = await client.messages.create({ model: MODEL, max_tokens: 1800, messages: [{ role: 'user', content: prompt }] })
    const text = (response.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim())
    const draft = normalizeArchiveCopyDraft(parsed, fallback)
    const serialized = JSON.stringify(draft)
    if (EMAIL.test(serialized) || PHONE.test(serialized) || MONEY.test(serialized) || SENSITIVE_LINE.test(serialized)) {
      console.warn('[archive-copy] Generated copy failed the public-content safety scan; using deterministic fallback.')
      return fallback
    }
    return draft
  } catch (error: any) {
    console.warn('[archive-copy] Draft generation failed; using deterministic fallback:', error.message)
    return fallback
  }
}
