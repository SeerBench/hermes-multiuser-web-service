import { useState } from 'react'
import type { FormEvent } from 'react'
import { auth } from '../api'
import {
  PlatformApiError,
  platform,
  storeWorkspaceId,
  type PlatformUser,
} from '../platformClient'
import { useT } from '../i18n'

type Props = {
  onSuccess: (user: PlatformUser) => void
  onLegacyKey: () => void
}

type Mode = 'login' | 'register'

export function AuthPage({ onSuccess, onLegacyKey }: Props) {
  const t = useT()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const fn = mode === 'login' ? platform.login : platform.register
      const res = await fn(email.trim(), password)
      if (res.workspace?.id) storeWorkspaceId(res.workspace.id)
      onSuccess(res.user)
    } catch (err) {
      if (err instanceof PlatformApiError) {
        setError(err.message)
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError(t('auth.error.generic'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>{t('auth.title')}</h1>
        <p className="auth-sub">{t('auth.subtitle')}</p>

        <div className="auth-tabs">
          <button
            type="button"
            className={mode === 'login' ? 'nav-active' : ''}
            onClick={() => setMode('login')}
          >
            {t('auth.login')}
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'nav-active' : ''}
            onClick={() => setMode('register')}
          >
            {t('auth.register')}
          </button>
        </div>

        <form onSubmit={submit} className="auth-form">
          <label>
            {t('auth.email')}
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            {t('auth.password')}
            <input
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </label>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? t('auth.submitting') : t('auth.submit')}
          </button>
        </form>

        <p className="auth-legacy">
          <button type="button" className="link-btn" onClick={onLegacyKey}>
            {t('auth.legacyKey')}
          </button>
        </p>
      </div>
    </div>
  )
}

/** Legacy API-key login wrapper (web_chat /api/auth/login). */
export async function legacyKeyLogin(apiKey: string): Promise<string> {
  const { user_id } = await auth.login(apiKey)
  return user_id
}
