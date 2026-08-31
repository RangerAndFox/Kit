import { Inngest } from 'inngest'

/**
 * Kit's Inngest client.
 *
 * All events and functions are scoped to this single client instance.
 * Import this wherever you need to send events or define functions.
 */
export const inngest = new Inngest({
  id: 'kit',
  /**
   * Event schemas are defined inline so Inngest can type-check
   * event payloads at send() and in function handlers.
   */
})
