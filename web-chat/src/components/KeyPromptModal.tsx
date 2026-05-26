import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError, auth } from '../api'
import { useT } from '../i18n'
import type { Translator } from '../i18n'

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
  const t = useT()
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
        setError(messageForCode(err.code, err.status, t))
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError(t('keymodal.error.generic', { status: 0 }))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const heading =
    reason === 'session-expired'
      ? t('keymodal.heading.expired')
      : t('keymodal.heading.first')
  const subline =
    reason === 'session-expired'
      ? t('keymodal.sub.expired')
      : t('keymodal.sub.first')

  return (
    <div className="keymodal-backdrop" role="dialog" aria-modal="true">
      <form className="keymodal-card" onSubmit={onSubmit}>
        <h1>{heading}</h1>
        <p className="keymodal-sub">{subline}</p>

        <label>
          <span>{t('keymodal.label.apikey')}</span>
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
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="keymodal-primary"
            disabled={submitting || !apiKey.trim()}
          >
            {submitting ? t('keymodal.submitting') : t('keymodal.submit')}
          </button>
        </div>

        <p className="keymodal-help">{t('keymodal.help')}</p>
      </form>
    </div>
  )
}

function messageForCode(
  code: string | undefined,
  status: number,
  t: Translator,
): string {
  switch (code) {
    case 'invalid_key':
      return t('keymodal.error.invalid_key')
    case 'upstream_unreachable':
      return t('keymodal.error.upstream_unreachable')
    case 'misconfigured':
      return t('keymodal.error.misconfigured')
    case 'missing_api_key':
      return t('keymodal.error.missing_api_key')
    default:
      return t('keymodal.error.generic', { status })
  }
}
