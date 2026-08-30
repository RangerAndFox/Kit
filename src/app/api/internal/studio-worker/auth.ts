import crypto from 'node:crypto'

export function isStudioWorkerAuthorized(request: Request, env: Record<string, string | undefined> = process.env): boolean {
  const expected = env.KIT_STUDIO_WORKER_SECRET || ''
  const supplied = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  return expected.length >= 32 && supplied.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
}
