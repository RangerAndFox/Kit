import type { Page, Request } from 'playwright-core'

export const isPublishLabel = (value: string): boolean => /^(save\s*(?:&|and)\s*)?publish(?:\s+project)?$/i.test(value.trim())

export function isPublishMutation(request: Pick<Request, 'method' | 'url' | 'postData'>): boolean {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method().toUpperCase())) return false
  const url = request.url()
  if (!/behance\.net/i.test(url)) return false
  const body = request.postData() || ''
  return /\/(?:publish)(?:[/?]|$)/i.test(url) || /["'](?:status|state)["']\s*:\s*["']published["']/i.test(body)
}

export async function installPublishLockout(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    if (isPublishMutation(route.request())) {
      console.error(`[safety] blocked possible Behance publish request: ${route.request().url()}`)
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })
  await page.addInitScript(() => {
    const lock = () => {
      document.querySelectorAll('button, a, [role="button"]').forEach((node) => {
        if (/^(save\s*(?:&|and)\s*)?publish(?:\s+project)?$/i.test((node.textContent || '').trim())) {
          node.setAttribute('aria-disabled', 'true')
          ;(node as HTMLElement).style.pointerEvents = 'none'
          if (node instanceof HTMLButtonElement) node.disabled = true
        }
      })
    }
    new MutationObserver(lock).observe(document.documentElement, { childList: true, subtree: true, characterData: true })
    document.addEventListener('click', (event) => {
      const node = (event.target as Element | null)?.closest('button, a, [role="button"]')
      if (node && /^(save\s*(?:&|and)\s*)?publish(?:\s+project)?$/i.test((node.textContent || '').trim())) {
        event.preventDefault(); event.stopImmediatePropagation()
      }
    }, true)
    lock()
  })
}
