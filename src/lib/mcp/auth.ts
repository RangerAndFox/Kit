import crypto from 'node:crypto'

export interface McpPrincipal {
  subject: string
  workspaceId: string
  tools: string[]
  expiresAt?: number
}

interface TokenPayload {
  v: 1
  sub: string
  workspace_id: string
  tools: string[]
  exp?: number
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
  const payload: TokenPayload = {
    v: 1,
    sub: principal.subject,
    workspace_id: principal.workspaceId,
    tools: [...new Set(principal.tools)].sort(),
    ...(principal.expiresAt ? { exp: principal.expiresAt } : {}),
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `kit1.${encoded}.${signature(encoded, secret)}`
}

export function verifyMcpToken(token: string, secret = signingSecret()): McpPrincipal | null {
  if (!secret) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'kit1') return null
  const expected = signature(parts[1], secret)
  const supplied = parts[2]
  if (expected.length !== supplied.length) return null
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
    if (payload.exp !== undefined && (!Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000))) return null
    return {
      subject: payload.sub,
      workspaceId: payload.workspace_id,
      tools: payload.tools,
      ...(payload.exp ? { expiresAt: payload.exp } : {}),
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
