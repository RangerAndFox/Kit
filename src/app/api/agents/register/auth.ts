import { timingSafeEqual } from 'node:crypto'

export function authorizeAgentRegistration(supplied: string, expected?: string): boolean {
  if (!supplied || !expected) return false
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}
