/**
 * MCP Protocol Types
 *
 * JSON-RPC 2.0 request/response shapes and MCP tool definitions.
 * We implement the MCP spec directly over HTTP rather than using the SDK
 * because we're running serverless (stateless, per-request) and don't
 * need transport adapters.
 */

import type { z } from 'zod'

// ─── JSON-RPC 2.0 ────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: '2.0'
  id: string | number | null
  result: T
}

export interface JsonRpcError {
  jsonrpc: '2.0'
  id: string | number | null
  error: {
    code: number
    message: string
    data?: unknown
  }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

// ─── MCP Content Blocks ──────────────────────────────────────

export interface TextContent {
  type: 'text'
  text: string
}

export type ToolContent = TextContent

export interface ToolCallResult {
  content: ToolContent[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

// ─── Kit Tool Definition ─────────────────────────────────────

export interface KitTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  schema: TSchema
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
  }
  handler: (input: z.infer<TSchema>) => Promise<ToolCallResult>
}
