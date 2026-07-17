import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { PageShell } from '../components/PageShell'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { useT } from '../i18n'
import {
  PlatformApiError,
  getStoredWorkspaceId,
  platform,
} from '../platformClient'
import { Button } from '@/components/ui/button'

export function MemoryPage() {
  const t = useT()
  const workspaceId = getStoredWorkspaceId()
  const [longTerm, setLongTerm] = useState('')
  const [profile, setProfile] = useState('')
  const [savedLong, setSavedLong] = useState('')
  const [savedProfile, setSavedProfile] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!workspaceId) return
    platform
      .getMemory(workspaceId)
      .then((m) => {
        setLongTerm(m.long_term)
        setProfile(m.profile)
        setSavedLong(m.long_term)
        setSavedProfile(m.profile)
      })
      .catch((err) =>
        toast.error(
          err instanceof PlatformApiError ? err.message : String(err),
        ),
      )
  }, [workspaceId])

  const dirty = longTerm !== savedLong || profile !== savedProfile

  const save = async () => {
    if (!workspaceId) return
    setBusy(true)
    try {
      await platform.patchMemory(workspaceId, {
        long_term: longTerm,
        profile: profile,
      })
      setSavedLong(longTerm)
      setSavedProfile(profile)
      toast.success(t('memory.saved'))
    } catch (err) {
      toast.error(
        err instanceof PlatformApiError ? err.message : String(err),
      )
    } finally {
      setBusy(false)
    }
  }

  if (!workspaceId) {
    return <p className="page-hint">{t('memory.noWorkspace')}</p>
  }

  return (
    <PageShell
      title={t('nav.memory')}
      hint={t('memory.intro')}
      density="reading"
      constrainWidth={false}
      actions={
        <Button type="button" disabled={busy || !dirty} onClick={() => void save()}>
          {t('memory.save')}
        </Button>
      }
    >
      <section className="memory-section">
        <h3>{t('memory.longTerm')}</h3>
        <MarkdownEditor
          value={longTerm}
          onChange={setLongTerm}
          editLabel={t('memory.edit')}
          previewLabel={t('memory.preview')}
        />
      </section>
      <section className="memory-section">
        <h3>{t('memory.profile')}</h3>
        <MarkdownEditor
          value={profile}
          onChange={setProfile}
          editLabel={t('memory.edit')}
          previewLabel={t('memory.preview')}
        />
      </section>
    </PageShell>
  )
}
