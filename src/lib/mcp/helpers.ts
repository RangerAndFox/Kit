/**
 * MCP Helpers
 *
 * Shared utilities for tool handlers — Supabase admin client,
 * result formatting, error formatting, zod-to-JSON-Schema conversion.
 */

import { z } from 'zod'
import type { ToolCallResult } from './types'

// ─── Supabase access ─────────────────────────────────────────

export { createAdminClient } from '@/lib/supabase/admin'

// ─── Result helpers ──────────────────────────────────────────

export function ok(data: unknown, summary?: string): ToolCallResult {
  const text = summary
    ? `${summary}\n\n${JSON.stringify(data, null, 2)}`
    : JSON.stringify(data, null, 2)
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>)
      : { value: data },
  }
}

export function fail(message: string, details?: unknown): ToolCallResult {
  const text = details
    ? `Error: ${message}\n\n${JSON.stringify(details, null, 2)}`
    : `Error: ${message}`
  return {
    content: [{ type: 'text', text }],
    isError: true,
  }
}

// ─── zod → JSON Schema ───────────────────────────────────────
// Use the supported Zod 4 converter instead of private Zod 3 internals.
// Input mode keeps optional/default fields optional for tool callers.
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io: "input", target: "draft-07",
    override: ({ zodSchema, jsonSchema }) => {
      // Preserve the existing MCP contract for object-shaped tool inputs.
      if (zodSchema instanceof z.ZodObject) jsonSchema.additionalProperties = false
    },
  })
}

// ─── Validation helper ───────────────────────────────────────

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): {
  ok: true; value: T
} | {
  ok: false; error: string; issues: unknown
} {
  const result = schema.safeParse(input)
  if (result.success) return { ok: true, value: result.data }
  return {
    ok: false,
    error: 'Invalid tool input',
    issues: result.error.issues,
  }
}
