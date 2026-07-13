import { useCallback, useEffect, useState } from 'react'
import { useT } from '../i18n'
import {
  PlatformApiError,
  getStoredWorkspaceId,
  platform,
  type SkillRow,
} from '../platformClient'

export function SkillsPage() {
  const t = useT()
  const workspaceId = getStoredWorkspaceId()
  const [skills, setSkills] = useState<SkillRow[]>([])
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!workspaceId) return
    try {
      setSkills(await platform.listSkills(workspaceId))
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [workspaceId])

  useEffect(() => {
    reload()
  }, [reload])

  const toggle = async (name: string, enabled: boolean) => {
    if (!workspaceId) return
    try {
      await platform.patchSkill(workspaceId, name, { enabled: !enabled })
      await reload()
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }

  if (!workspaceId) {
    return <p className="page-hint">{t('skills.noWorkspace')}</p>
  }

  return (
    <div className="panel-page">
      <h2>{t('nav.skills')}</h2>
      <p className="page-hint">{t('skills.hint')}</p>
      {error && <p className="auth-error">{error}</p>}
      <ul className="skill-list">
        {skills.map((s) => (
          <li key={s.name}>
            <div>
              <strong>{s.name}</strong>
              <small> ({s.source})</small>
              {s.description && <p>{s.description}</p>}
            </div>
            <label className="skill-toggle">
              <input
                type="checkbox"
                checked={s.enabled !== false}
                onChange={() => toggle(s.name, s.enabled !== false)}
              />
              {t('skills.enabled')}
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}
