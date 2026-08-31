import { NextResponse } from 'next/server'

/** Credential-bearing MCP URLs were retired. Use the bearer-authenticated endpoint. */
function retired() {
  return NextResponse.json(
    { error: 'Credential-bearing MCP URLs are no longer supported.' },
    { status: 410, headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function GET() {
  return retired()
}

export async function POST() {
  return retired()
}
