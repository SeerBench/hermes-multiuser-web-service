import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import {
  PlatformApiError,
  getStoredWorkspaceId,
  platform,
} from '../platformClient'

export function MemoryPage() {
  const t = useT()
  const workspaceId = getStoredWorkspaceId()
  const [longTerm, setLongTerm] = useState('')
  const [profile, setProfile] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!workspaceId) return
    platform
      .getMemory(workspaceId)
      .then((m) => {
        setLongTerm(m.long_term)
        setProfile(m.profile)
      })
      .catch((err) =>
        setError(err instanceof PlatformApiError ? err.message : String(err)),
      )
  }, [workspaceId])

  const save = async () => {
    if (!workspaceId) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      await platform.patchMemory(workspaceId, {
        long_term: longTerm,
        profile: profile,
      })
      setStatus(t('memory.saved'))
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!workspaceId) {
    return <p className="page-hint">{t('memory.noWorkspace')}</p>
  }

  return (
    <div className="panel-page">
      <h2>{t('nav.memory')}</h2>
      <label>
        {t('memory.longTerm')}
        <textarea
          rows={12}
          value={longTerm}
          onChange={(e) => setLongTerm(e.target.value)}
        />
      </label>
      <label>
        {t('memory.profile')}
        <textarea
          rows={8}
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
        />
      </label>
      {error && <p className="auth-error">{error}</p>}
      {status && <p className="page-ok">{status}</p>}
      <button type="button" disabled={busy} onClick={save}>
        {t('memory.save')}
      </button>
    </div>
  )
}
