/** No credentials are forwarded. Every hop must remain on a provider-owned host. */
export function frameioPublicUrl(value: string): URL {
  const url = new URL(value)
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !(host === 'f.io' || host === 'frame.io' || host.endsWith('.frame.io') || host === 'frameio.net' || host.endsWith('.frameio.net'))) {
    throw new Error('Untrusted Frame.io URL')
  }
  return url
}

export async function fetchFrameioPublicUrl(value: string, request: typeof fetch = fetch): Promise<{ response: Response; url: string }> {
  let url = frameioPublicUrl(value)
  const signal = AbortSignal.timeout(10_000)
  for (let hop = 0; hop <= 5; hop++) {
    const response = await request(url.href, { redirect: 'manual', signal })
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: url.href }
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || hop === 5) throw new Error('Frame.io redirect limit or missing destination')
    url = frameioPublicUrl(new URL(location, url).href)
  }
  throw new Error('Frame.io redirect limit')
}
