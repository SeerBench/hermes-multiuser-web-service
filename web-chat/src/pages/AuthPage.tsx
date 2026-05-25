import { useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError, auth, usage as usageApi } from '../api'
import type { Quota, User } from '../api'

type Mode = 'login' | 'register'

type Props = {
  onAuthed: (user: User, initialQuota?: Quota) => void
}

export function AuthPage({ onAuthed }: Props) {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // New-key reveal modal: only fires on register; the plaintext API
  // key is never returned again, so we surface it prominently with
  // a one-shot copy affordance.
  const [issuedKey, setIssuedKey] = useState<{ user: User; key: string } | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      if (mode === 'login') {
        const user = await auth.login(email, password)
        const quota = await usageApi.get().catch(() => undefined)
        onAuthed(user, quota)
      } else {
        const result = await auth.register(email, password)
        const { api_key, ...user } = result
        setIssuedKey({ user, key: api_key })
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message || `error ${err.status}`)
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError('unknown error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (issuedKey) {
    return <NewKeyReveal user={issuedKey.user} apiKey={issuedKey.key} onContinue={onAuthed} />
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={onSubmit}>
        <h1>Hermes Web Chat</h1>
        <p className="auth-sub">
          {mode === 'login' ? 'Sign in to continue.' : 'Create an account to begin.'}
        </p>

        <label>
          <span>Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label>
          <span>Password</span>
          <input
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
        </label>

        {error && <p className="auth-error">{error}</p>}

        <button type="submit" disabled={submitting} className="auth-primary">
          {submitting ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        <p className="auth-switch">
          {mode === 'login' ? (
            <>
              No account?{' '}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setMode('register')
                  setError(null)
                }}
              >
                Register
              </button>
            </>
          ) : (
            <>
              Already have one?{' '}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setMode('login')
                  setError(null)
                }}
              >
                Sign in
              </button>
            </>
          )}
        </p>
      </form>
    </div>
  )
}

function NewKeyReveal({
  user,
  apiKey,
  onContinue,
}: {
  user: User
  apiKey: string
  onContinue: (user: User) => void
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(apiKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // older browsers — user can select manually
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>Your API key</h1>
        <p className="auth-sub">
          We will <strong>never show this again</strong>. Copy it now if you plan
          to use it from scripts or non-browser clients. The cookie session is
          already active, so you can continue without saving the key — you can
          always create another from Settings later.
        </p>

        <code className="auth-key">{apiKey}</code>

        <button type="button" className="auth-primary" onClick={copy}>
          {copied ? 'Copied!' : 'Copy to clipboard'}
        </button>

        <button
          type="button"
          className="auth-secondary"
          onClick={() => onContinue(user)}
        >
          Continue to chat
        </button>
      </div>
    </div>
  )
}
