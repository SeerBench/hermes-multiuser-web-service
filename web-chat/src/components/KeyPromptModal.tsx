import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError, auth } from '../api'

type Props = {
  // Why the modal opened.  Drives the heading copy so the user knows
  // whether this is the first-time login or a forced re-auth.
  reason: 'first-message' | 'session-expired'
  onSuccess: (userId: string) => void
  onCancel: () => void
}

/**
 * Modal that asks the user to paste their new-api key.  Shown on the
 * first message attempt (no cookie yet) or when the server returns 401
 * mid-session (cookie expired, master key rotated, etc.).
 *
 * On submit, calls POST /api/auth/login {api_key}.  The server probes
 * the upstream new-api gateway once with the key; only a 2xx upstream
 * response results in a session cookie.  Errors are mapped from the
 * server's `code` field into user-facing messages.
 */
export function KeyPromptModal({ reason, onSuccess, onCancel }: Props) {
  const [apiKey, setApiKey] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Esc to dismiss.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, submitting])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = apiKey.trim()
    if (!trimmed) return
    setSubmitting(true)
    setError(null)
    try {
      const { user_id } = await auth.login(trimmed)
      onSuccess(user_id)
    } catch (err) {
      if (err instanceof ApiError) {
        setError(messageForCode(err.code, err.status))
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError('Login failed.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const heading =
    reason === 'session-expired'
      ? 'Session expired'
      : 'Sign in with your API key'
  const subline =
    reason === 'session-expired'
      ? 'Your session is no longer valid. Paste your API key to continue.'
      : 'Paste the API key your administrator issued from the new-api gateway.'

  return (
    <div className="keymodal-backdrop" role="dialog" aria-modal="true">
      <form className="keymodal-card" onSubmit={onSubmit}>
        <h1>{heading}</h1>
        <p className="keymodal-sub">{subline}</p>

        <label>
          <span>API key</span>
          <input
            ref={inputRef}
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={submitting}
            placeholder="sk-…"
          />
        </label>

        {error && <p className="keymodal-error">{error}</p>}

        <div className="keymodal-actions">
          <button
            type="button"
            className="keymodal-secondary"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="keymodal-primary"
            disabled={submitting || !apiKey.trim()}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </div>

        <p className="keymodal-help">
          Don't have a key yet? Ask your administrator. Keys are issued
          and billed through the upstream gateway, not here.
        </p>
      </form>
    </div>
  )
}

function messageForCode(
  code: string | undefined,
  status: number,
): string {
  switch (code) {
    case 'invalid_key':
      return 'That API key was rejected by the upstream gateway. Check it for typos or ask your admin for a new one.'
    case 'upstream_unreachable':
      return 'The upstream gateway is unreachable right now. Try again in a moment.'
    case 'misconfigured':
      return 'The server can\'t reach the configured upstream URL. Ask your administrator to check the new-api configuration.'
    case 'missing_api_key':
      return 'Please paste your API key.'
    default:
      return `Login failed (HTTP ${status}).`
  }
}
