import { useCallback, useEffect, useState } from 'react'
import { formatBytes } from '../format'
import { useT } from '../i18n'
import {
  PlatformApiError,
  getStoredWorkspaceId,
  platform,
  type PlatformFile,
} from '../platformClient'

export function FilesPage() {
  const t = useT()
  const workspaceId = getStoredWorkspaceId()
  const [files, setFiles] = useState<PlatformFile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    if (!workspaceId) return
    try {
      setFiles(await platform.listFiles(workspaceId))
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [workspaceId])

  useEffect(() => {
    reload()
  }, [reload])

  const onUpload = async (list: FileList | null) => {
    if (!workspaceId || !list?.length) return
    setBusy(true)
    setError(null)
    try {
      await platform.uploadFiles(workspaceId, Array.from(list))
      await reload()
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (id: string) => {
    if (!workspaceId) return
    setBusy(true)
    try {
      await platform.deleteFile(workspaceId, id)
      await reload()
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!workspaceId) {
    return <p className="page-hint">{t('files.noWorkspace')}</p>
  }

  return (
    <div className="panel-page">
      <h2>{t('nav.files')}</h2>
      <p className="page-hint">{t('files.hint')}</p>
      <input
        type="file"
        multiple
        accept=".pdf,.docx,.xlsx,.pptx,.txt,.md"
        disabled={busy}
        onChange={(e) => onUpload(e.target.files)}
      />
      {error && <p className="auth-error">{error}</p>}
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.id}>
            <span>
              {f.filename}{' '}
              <small>
                ({formatBytes(f.size_bytes ?? 0)}) — {f.status}
              </small>
            </span>
            <button type="button" disabled={busy} onClick={() => onDelete(f.id)}>
              {t('files.delete')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
