import { z } from 'zod'

export const KINDS = ['birthday', 'timesheet', 'holiday', 'delivery', 'custom'] as const
export type CultureKind = typeof KINDS[number]
export const SECTION_NAMES: Record<CultureKind, string> = {
  birthday: 'Birthday memes', timesheet: 'Timesheet memes', holiday: 'Holiday memes',
  delivery: 'Delivery celebrations', custom: 'Custom memes',
}
export const TEMPLATE_NAMES: Record<string, string> = {
  rotation: 'Automatic rotation', '181913649': 'Drake Hotline Bling', '61544': 'Success Kid',
  '124055727': 'Leonardo DiCaprio Cheers', '129242436': 'Change My Mind', '155067746': 'Surprised Pikachu',
  '61579': 'One Does Not Simply', '93895088': 'Expanding Brain', '87743020': 'Two Buttons',
  '4087833': 'Waiting Skeleton', '438680': 'Batman Slapping Robin', '131940431': "Gru’s Plan",
  '102156234': 'Mocking Spongebob', '55311130': 'This Is Fine', '217743513': 'UNO Draw 25',
  '124822590': 'Left Exit 12 Off Ramp',
}
export const CELEBRATION_IDS = ['181913649', '61544', '124055727', '129242436', '155067746', '61579', '93895088']
export const TIMESHEET_IDS = ['181913649', '87743020', '129242436', '4087833', '61579', '438680', '131940431', '93895088', '102156234', '55311130', '217743513', '124822590']

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}
export function validMonthDay(value: string): boolean { return validDate(`2000-${value}`) }
export function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true } catch { return false }
}
/** Conservative guard, not a claim that arbitrary text can be proven non-sensitive. */
export function publicSafeText(value: string): boolean {
  return !/[$€£¥]|\b(?:budget|salary|salaries|payroll|hourly rate|day rate|profit|margin|invoice|confidential|password|api[ _-]?key)\b|\b\S+@\S+\.\S+|(?:\+?\d[\s().-]*){9,}|https?:\/\/|<[@!#]/i.test(value)
}
const text = (max: number) => z.string().trim().min(1).max(max)
export const memeSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().min(0), kind: z.enum(KINDS),
  name: text(100), briefing: z.string().trim().max(600), channel_id: z.string().regex(/^[CG][A-Z0-9]{8,}$/),
  template_id: z.string().refine(value => Object.hasOwn(TEMPLATE_NAMES, value)),
  status: z.enum(['draft', 'enabled', 'paused']),
  schedule: z.enum(['annual', 'weekly', 'once', 'holiday', 'delivery']),
  month_day: z.string().nullable(), weekday: z.number().int().min(0).max(6).nullable(),
  fire_date: z.string().nullable(), local_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timezone: text(80).refine(validTimezone),
  person_id: z.string().regex(/^[UW][A-Z0-9]{8,}$/).nullable(), person_name: z.string().trim().max(100).nullable(),
}).strict().superRefine((item, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (!publicSafeText(`${item.name} ${item.briefing} ${item.person_name || ''}`)) invalid('Use public-safe wording without financial details, contacts, links or secrets.')
  if (item.schedule === 'annual' && (!item.month_day || !validMonthDay(item.month_day))) invalid('Choose a valid month and day.')
  if (item.schedule === 'weekly' && item.weekday === null) invalid('Choose a weekday.')
  if (item.schedule === 'once' && (!item.fire_date || !validDate(item.fire_date))) invalid('Choose a valid date.')
  if (item.kind === 'birthday' && (item.schedule !== 'annual' || !item.person_id || !item.person_name)) invalid('Birthdays require an employee and an annual date.')
  if (item.kind === 'timesheet' && item.schedule !== 'weekly') invalid('Timesheet memes repeat weekly.')
  if (item.kind === 'holiday' && !['holiday', 'annual'].includes(item.schedule)) invalid('Choose studio holidays or an annual holiday.')
  if (item.kind === 'delivery' && item.schedule !== 'delivery') invalid('Delivery celebrations use the delivery event.')
  if (item.kind === 'custom' && !['once', 'weekly', 'annual'].includes(item.schedule)) invalid('Choose a date or recurrence.')
  if (item.kind !== 'birthday' && (item.person_id || item.person_name)) invalid('Employee fields belong only to birthdays.')
  if (item.template_id !== 'rotation' && !(item.kind === 'timesheet' ? TIMESHEET_IDS : CELEBRATION_IDS).includes(item.template_id)) invalid('Choose a template for this meme type.')
})
export type Meme = z.infer<typeof memeSchema>
export interface CulturePost {
  id: string; meme_id: string; name: string; occurrence_key: string; channel_id: string;
  status: 'claimed' | 'sending' | 'posted' | 'failed' | 'review' | 'cancelled';
  created_at: string; posted_at: string | null; slack_ts: string | null; error: string | null;
}
export interface CultureWorkspace { workspace_id: string; starts_at: string; default_channel_id: string; timezone: string; heartbeat_at: string | null }
export interface CultureData {
  workspace: CultureWorkspace | null; memes: Meme[]; posts: CulturePost[];
  people: { id: string; name: string }[]; channels: { id: string; name: string }[];
  generatedAt: string; warning: string | null;
  holidays: string[];
}
export function localParts(now: Date, timezone: string): { date: string; time: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const part = (key: string) => parts.find(p => p.type === key)!.value
  const date = `${part('year')}-${part('month')}-${part('day')}`
  return { date, time: `${part('hour')}:${part('minute')}`, weekday: new Date(`${date}T12:00:00Z`).getUTCDay() }
}
export function addDays(date: string, days: number): string { return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10) }
export function matchesDay(item: Meme, date: string, isHoliday: (date: string) => boolean): boolean {
  if (item.schedule === 'once') return item.fire_date === date
  if (item.schedule === 'annual') return item.month_day === date.slice(5)
  if (item.schedule === 'weekly') return item.weekday === new Date(`${date}T12:00:00Z`).getUTCDay()
  return item.schedule === 'holiday' && isHoliday(date)
}
/** Five-minute delivery window. Missed dates do not become surprise catch-up posts. DST folds share a key. */
export function dueKey(item: Meme, now: Date, isHoliday: (date: string) => boolean): string | null {
  if (item.status !== 'enabled' || item.schedule === 'delivery') return null
  const local = localParts(now, item.timezone)
  const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
  const late = minute(local.time) - minute(item.local_time)
  return late >= 0 && late < 5 && matchesDay(item, local.date, isHoliday) ? local.date : null
}
export function nextDate(item: Meme, now: Date, holidays: string[] = []): string | null {
  if (item.status !== 'enabled' || item.schedule === 'delivery') return null
  const local = localParts(now, item.timezone)
  for (let day = 0; day <= 370; day++) {
    const date = addDays(local.date, day)
    if (day === 0 && item.local_time < local.time) continue
    if (matchesDay(item, date, value => holidays.includes(value))) return date
  }
  return null
}
/** Find the next local midnight without assuming a fixed UTC offset across DST. */
export function nextMidnight(now: Date, timezone: string): string {
  const today = localParts(now, timezone).date
  for (let minute = 1; minute <= 1560; minute++) {
    const time = new Date(Math.floor(now.getTime() / 60000) * 60000 + minute * 60000)
    const local = localParts(time, timezone)
    if (local.date !== today && local.time === '00:00') return time.toISOString()
  }
  throw new Error('Could not determine a safe cutover time.')
}
export function newMeme(kind: CultureKind, channel: string, timezone: string, id: string): Meme {
  return { id, revision: 0, kind, name: kind === 'custom' ? '' : SECTION_NAMES[kind], briefing: '', channel_id: channel,
    template_id: 'rotation', status: 'draft', schedule: kind === 'birthday' ? 'annual' : kind === 'timesheet' ? 'weekly' : kind === 'holiday' ? 'holiday' : kind === 'delivery' ? 'delivery' : 'once',
    month_day: null, weekday: kind === 'timesheet' ? 5 : null, fire_date: null, local_time: '09:00', timezone, person_id: null, person_name: null }
}
export const escapeSlack = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[*_`]/g, '')
