'use client'

import Image from 'next/image'
import { useState } from 'react'
import { signInWithMagicLink, signInWithGoogle } from './actions'
import styles from './login.module.css'

type AuthState = 'idle' | 'loading' | 'success' | 'error'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<AuthState>('idle')
  const [error, setError] = useState('')

  const handleMagicLink = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setState('loading')

    const formData = new FormData()
    formData.append('email', email)
    const result = await signInWithMagicLink(formData)

    if (result.error) {
      setError(result.error)
      setState('error')
    } else {
      setState('success')
    }
  }

  const handleGoogleSignIn = async () => {
    setError('')
    setState('loading')
    try {
      const result = await signInWithGoogle()
      if (result?.error) {
        setError(result.error)
        setState('error')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign in with Google')
      setState('error')
    }
  }

  const unavailable = state === 'loading' || state === 'success'
  const googleEnabled = process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED === 'true'

  return (
    <main className={styles.page}>
      <div className={styles.ambient} aria-hidden="true" />

      <section className={styles.shell} aria-labelledby="login-title">
        <header className={styles.brand}>
          <div className={styles.iconFrame}>
            <Image
              src="/kit-icon.png"
              alt="Kit"
              width={72}
              height={72}
              priority
              className={styles.icon}
            />
          </div>
          <p className={styles.eyebrow}>Ranger &amp; Fox studio operations</p>
          <h1 id="login-title" className={styles.title}>Welcome back</h1>
          <p className={styles.subtitle}>Sign in to your production control center.</p>
        </header>

        <div className={styles.card}>
          <div className={styles.cardIntro}>
            <h2>Sign in to Kit</h2>
            <p>Use your Ranger &amp; Fox email to continue.</p>
          </div>

          <div className={styles.statusRegion} aria-live="polite">
            {state === 'success' && (
              <div className={`${styles.notice} ${styles.success}`}>
                <span className={styles.noticeMark} aria-hidden="true">✓</span>
                <div>
                  <strong>Check your inbox</strong>
                  <p>We sent a secure sign-in link to {email}.</p>
                </div>
              </div>
            )}

            {state === 'error' && error && (
              <div className={`${styles.notice} ${styles.error}`} role="alert">
                <span className={styles.noticeMark} aria-hidden="true">!</span>
                <div>
                  <strong>We couldn’t sign you in</strong>
                  <p>{error}</p>
                </div>
              </div>
            )}
          </div>

          <form onSubmit={handleMagicLink} className={styles.form}>
            <label htmlFor="email" className={styles.label}>Email address</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="name@rangerandfox.tv"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={unavailable}
              className={styles.input}
              required
            />
            <button
              type="submit"
              disabled={unavailable || !email}
              className={styles.primaryButton}
            >
              {state === 'loading' ? 'Sending secure link…' : 'Email me a sign-in link'}
            </button>
          </form>

          {googleEnabled && (
            <>
              <div className={styles.divider} aria-hidden="true">
                <span />
                <p>or continue with</p>
                <span />
              </div>

              <button
                type="button"
                onClick={handleGoogleSignIn}
                disabled={unavailable}
                className={styles.googleButton}
              >
                <svg className={styles.googleIcon} viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                </svg>
                Continue with Google
              </button>
            </>
          )}

          <p className={styles.helper}>No password required. Magic links expire automatically.</p>
        </div>

        <footer className={styles.footer}>
          <span className={styles.lock} aria-hidden="true">●</span>
          Private access for the Ranger &amp; Fox team
        </footer>
      </section>
    </main>
  )
}
