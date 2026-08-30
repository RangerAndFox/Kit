// @ts-nocheck
import { NextResponse } from 'next/server'
import { getAgentRegistry } from '@/lib/managed-agents/agent-registry'
import { ALL_AGENTS } from '../../../../../agents'
import { authorizeAgentRegistration } from './auth'

/**
 * POST /api/agents/register
 */
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('authorization')
    const expectedKey = process.env.KIT_AGENT_REGISTRATION_SECRET?.trim()
    const suppliedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!authorizeAgentRegistration(suppliedKey, expectedKey)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const registry = getAgentRegistry()
    const environmentId = await registry.ensureEnvironment('kit-production')

    // Register each agent and capture successes + failures
    const results: any[] = []
    const failures: any[] = []
    for (const def of ALL_AGENTS) {
      try {
        const r = await registry.register(def)
        results.push(r)
      } catch (err: any) {
        failures.push({
          key: def.key,
          message: err?.message || String(err),
          status: err?.status,
          body: err?.body,
        })
      }
    }

    return NextResponse.json({
      ok: true,
      environmentId,
      registered: results.length,
      failed: failures.length,
      agents: results,
      failures,
      env: {
        has_app_url: !!process.env.NEXT_PUBLIC_APP_URL,
        has_kit_mcp_secret: !!process.env.KIT_MCP_SECRET,
      },
    })
  } catch (error: any) {
    console.error('[Agent Registration] Error:', error)
    return NextResponse.json(
      { error: 'Registration failed' },
      { status: 500 }
    )
  }
}
