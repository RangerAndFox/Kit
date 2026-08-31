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
// Minimal zod-to-JSON-Schema converter. Handles the subset of shapes we
// actually use in our tool schemas: object with string/number/boolean/enum/
// array/object/optional/nullable/default/describe.

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as any)._def
  const typeName = def?.typeName

  // unwrap optional / nullable / default
  if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
    return zodToJsonSchema(def.innerType)
  }
  if (typeName === 'ZodDefault') {
    const inner = zodToJsonSchema(def.innerType)
    const defVal = typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue
    return { ...inner, default: defVal }
  }

  const base: Record<string, unknown> = {}
  if (def?.description) base.description = def.description

  switch (typeName) {
    case 'ZodString': {
      base.type = 'string'
      const checks = def.checks || []
      for (const c of checks) {
        if (c.kind === 'min') base.minLength = c.value
        if (c.kind === 'max') base.maxLength = c.value
        if (c.kind === 'uuid') base.format = 'uuid'
        if (c.kind === 'email') base.format = 'email'
        if (c.kind === 'url') base.format = 'uri'
      }
      return base
    }
    case 'ZodNumber': {
      base.type = 'number'
      for (const c of def.checks || []) {
        if (c.kind === 'int') base.type = 'integer'
        if (c.kind === 'min') base.minimum = c.value
        if (c.kind === 'max') base.maximum = c.value
      }
      return base
    }
    case 'ZodBoolean':
      base.type = 'boolean'
      return base
    case 'ZodEnum':
      base.type = 'string'
      base.enum = def.values
      return base
    case 'ZodArray':
      base.type = 'array'
      base.items = zodToJsonSchema(def.type)
      return base
    case 'ZodObject': {
      base.type = 'object'
      const shape: Record<string, z.ZodTypeAny> = def.shape()
      const props: Record<string, unknown> = {}
      const required: string[] = []
      for (const [key, val] of Object.entries(shape)) {
        props[key] = zodToJsonSchema(val)
        const innerTypeName = (val as any)._def?.typeName
        if (innerTypeName !== 'ZodOptional' && innerTypeName !== 'ZodDefault') {
          required.push(key)
        }
      }
      base.properties = props
      if (required.length) base.required = required
      base.additionalProperties = false
      return base
    }
    case 'ZodRecord':
      base.type = 'object'
      base.additionalProperties = true
      return base
    case 'ZodAny':
    case 'ZodUnknown':
      return {}
    default:
      return { type: 'string' }
  }
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
