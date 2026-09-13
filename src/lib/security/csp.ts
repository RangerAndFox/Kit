/** Script nonces are request-local; inline styles remain for Motion/UI styles. */
export function contentSecurityPolicy(nonce: string, development = false): string {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(nonce)) throw new Error('Invalid nonce')
  return [
    "default-src 'self'", "base-uri 'self'", "frame-ancestors 'none'", "object-src 'none'", "form-action 'self'",
    "img-src 'self' data: https:", "font-src 'self' data:", "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.inngest.com https://*.inngest.com" + (development ? ' ws: http://localhost:*' : ''),
  ].join('; ')
}
