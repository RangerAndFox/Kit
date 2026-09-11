import crypto from 'node:crypto'

export interface McpPrincipal {
  subject: string
  workspaceId: string
  tools: string[]
  expiresAt?: number
  tokenId?: string
}

interface TokenPayload {
  v: 1
  sub: string
  workspace_id: string
  tools: string[]
  exp?: number
  iat?: number
  jti?: string
}

const MAX_TOKEN_SECONDS = 90 * 24 * 60 * 60
const DEFAULT_TOKEN_SECONDS = 30 * 24 * 60 * 60

export function mcpTokenFingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function signingSecret(): string {
  return (process.env.KIT_MCP_SIGNING_SECRET || process.env.KIT_MCP_SECRET || '').trim()
}

function signature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

export function createMcpToken(principal: McpPrincipal, secret = signingSecret()): string {
  if (!secret) throw new Error('KIT_MCP_SIGNING_SECRET is required')
  if (!principal.subject || !principal.workspaceId || principal.tools.length === 0) {
    throw new Error('MCP tokens require a subject, workspace, and at least one tool')
  }
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = principal.expiresAt ?? issuedAt + DEFAULT_TOKEN_SECONDS
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt || expiresAt > issuedAt + MAX_TOKEN_SECONDS) {
    throw new Error('MCP expiry must be in the future and within 90 days')
  }
  const payload: TokenPayload = {
    v: 1,
    sub: principal.subject,
    workspace_id: principal.workspaceId,
    tools: [...new Set(principal.tools)].sort(),
    exp: expiresAt,
    iat: issuedAt,
    jti: principal.tokenId || crypto.randomUUID(),
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `kit1.${encoded}.${signature(encoded, secret)}`
}

export function verifyMcpToken(token: string, secret = signingSecret()): McpPrincipal | null {
  if (!secret) return null
  const revoked = (process.env.KIT_MCP_REVOKED_TOKEN_HASHES || '').split(',').map(v => v.trim())
  if (revoked.includes(mcpTokenFingerprint(token))) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'kit1') return null
  const expected = signature(parts[1], secret)
  const supplied = parts[2]
  if (!/^[A-Za-z0-9_-]+$/.test(supplied) || expected.length !== supplied.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return null

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as TokenPayload
    if (
      payload.v !== 1 ||
      typeof payload.sub !== 'string' || !payload.sub ||
      typeof payload.workspace_id !== 'string' || !payload.workspace_id ||
      !Array.isArray(payload.tools) || payload.tools.length === 0 ||
      payload.tools.some((tool) => typeof tool !== 'string' || !tool)
    ) return null
    const now = Math.floor(Date.now() / 1000)
    if (!Number.isSafeInteger(payload.exp) || payload.exp! <= now || payload.exp! > now + MAX_TOKEN_SECONDS) return null
    if (payload.iat !== undefined && (!Number.isSafeInteger(payload.iat) || payload.iat > now + 60 || payload.exp! - payload.iat > MAX_TOKEN_SECONDS)) return null
    const notBefore = Number(process.env.KIT_MCP_NOT_BEFORE || '0')
    if (!Number.isFinite(notBefore) || (notBefore > 0 && (!payload.iat || payload.iat < notBefore))) return null
    return {
      subject: payload.sub,
      workspaceId: payload.workspace_id,
      tools: payload.tools,
      ...(payload.exp ? { expiresAt: payload.exp } : {}),
      ...(payload.jti ? { tokenId: payload.jti } : {}),
    }
  } catch {
    return null
  }
}

export function checkMcpAuth(request: Request):
  | { ok: true; principal: McpPrincipal }
  | { ok: false; message: string } {
  if (!signingSecret()) return { ok: false, message: 'MCP authentication is not configured' }
  const auth = request.headers.get('authorization') || ''
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match) return { ok: false, message: 'Missing Authorization bearer token' }
  const principal = verifyMcpToken(match[1].trim())
  if (!principal) return { ok: false, message: 'Invalid or expired MCP token' }
  return { ok: true, principal }
}
