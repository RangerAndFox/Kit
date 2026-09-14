import { z } from 'zod'
import { memeSchema, validTimezone, type CultureData } from './model'
import { LegacyImportReviewError } from './legacy-import'

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('initialize'), channel: z.string().regex(/^[CG][A-Z0-9]{8,}$/), timezone: z.string().max(80).refine(validTimezone), confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal('save'), item: memeSchema, confirmed: z.boolean() }).strict(),
])
export interface CultureHttpPorts {
  access(): Promise<{ workspaceId: string; userId: string } | null>
  load(workspace: string): Promise<CultureData>
  initialize(workspace: string, actor: string, channel: string, timezone: string): Promise<void>
  save(workspace: string, actor: string, item: z.infer<typeof memeSchema>, confirmed: boolean): Promise<unknown>
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
export async function handleCulture(request: Request, ports: CultureHttpPorts): Promise<Response> {
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Request denied.' }, 403)
  let access
  try { access = await ports.access() } catch { return json({ error: 'Request denied.' }, 403) }
  if (!access) return json({ error: 'Admin access required.' }, 403)
  try {
    if (request.method === 'GET') return json(await ports.load(access.workspaceId))
    const reader = request.body?.getReader()
    if (!reader) return json({ error: 'Invalid request.' }, 400)
    let bytes = 0
    let text = ''
    const decoder = new TextDecoder()
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > 12000) { await reader.cancel(); return json({ error: 'Request too large.' }, 413) }
        text += decoder.decode(part.value, { stream: true })
      }
      text += decoder.decode()
    } finally { reader.releaseLock() }
    let raw: unknown
    try { raw = JSON.parse(text) } catch { return json({ error: 'Invalid request.' }, 400) }
    const parsed = Input.safeParse(raw)
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message || 'Check the form fields.' }, 400)
    const input = parsed.data
    if (input.action === 'initialize') await ports.initialize(access.workspaceId, access.userId, input.channel, input.timezone)
    else await ports.save(access.workspaceId, access.userId, input.item, input.confirmed)
    // Do not reload after mutation: an unrelated Slack lookup failure must not
    // turn a successful save into a false failure and encourage duplicate adds.
    return json({ ok: true })
  } catch (cause) {
    // No raw exception/body: provider errors can contain private record values.
    console.error('[culture-center] request_failed', { method: request.method, workspaceId: access.workspaceId, code: cause instanceof LegacyImportReviewError ? cause.code : 'operation_failed' })
    if (cause instanceof LegacyImportReviewError) return json({ error: cause.message }, 409)
    return json({ error: request.method === 'GET' ? 'Culture Center is unavailable. Check the migration and Slack connection.' : 'Not saved. Refresh for current changes, verify the employee/channel, and check for an existing birthday or a post currently sending.' }, 409)
  }
}
