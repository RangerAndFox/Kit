// @ts-nocheck
/**
 * Detect "deliver" / "transcode" intent in @Kit messages.
 *
 * Triggers on: "deliver", "transcode", "render", "delivery", "ingest" — with verb co-occurrence
 * to filter natural-language false positives.
 */

const DELIVER_KEYWORDS = /\b(deliver(?:y)?|transcod(?:e|ing)|render\s*(?:job|queue|file)|delivery\s*spec)\b/i

export function isDeliveryTrigger(text: string): boolean {
  if (!text) return false
  return DELIVER_KEYWORDS.test(text)
}
