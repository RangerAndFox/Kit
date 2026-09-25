import crypto from 'node:crypto'

export function isStudioWorkerAuthorized(request: Request, env: Record<string, string | undefined> = process.env): boolean {
  const expected = env.KIT_STUDIO_WORKER_SECRET || ''
  const supplied = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  const expectedBytes = Buffer.from(expected), suppliedBytes = Buffer.from(supplied)
  return expected.length >= 32 && suppliedBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(expectedBytes, suppliedBytes)
}

/** Workers are studio-wide capabilities, not multi-tenant user credentials. */
export function isSingleStudio(rows: Array<{ id: string }> | null): boolean {
  return rows?.length === 1 && typeof rows[0].id === 'string' && rows[0].id.length > 0
}
