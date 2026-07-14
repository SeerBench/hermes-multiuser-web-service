import { useCallback, useEffect, useState } from 'react'
import { formatBytes } from '../format'
import {
  FILE_INGEST_POLL_MS,
  isTerminalFileStatus,
  mergeFileUpdates,
} from '../fileIngestion'
import { useT } from '../i18n'
import {
  PlatformApiError,
  getStoredWorkspaceId,
  platform,
  type PlatformFile,
} from '../platformClient'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function FileStatusBadge({ file }: { file: PlatformFile }) {
  const t = useT()
  const label = t(`files.status.${file.status}` as 'files.status.pending')
  const inFlight = file.status === 'pending' || file.status === 'processing'

  const variant =
    file.status === 'ready'
      ? 'default'
      : file.status === 'failed'
        ? 'destructive'
        : 'secondary'

  return (
    <span className="file-status-wrap">
      <Badge
        variant={variant}
        title={file.error_message ?? undefined}
        className={cn(
          file.status === 'ready' && 'bg-emerald-600/20 text-emerald-500 hover:bg-emerald-600/20',
          inFlight && 'gap-1.5',
        )}
      >
        {inFlight && <span className="file-status-spinner" aria-hidden />}
        {label}
      </Badge>
      {file.status === 'failed' && file.error_message && (
        <span className="file-status-error">{file.error_message}</span>
      )}
    </span>
  )
}

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

  // 对 pending / processing 文件轮询 status 端点，直到 ready 或 failed。
  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false

    const poll = () => {
      setFiles((prev) => {
        const pending = prev.filter((f) => !isTerminalFileStatus(f.status))
        if (!pending.length) return prev

        void (async () => {
          const updates = await Promise.all(
            pending.map((f) =>
              platform.getFileStatus(workspaceId, f.id).catch(() => null),
            ),
          )
          if (cancelled) return
          setFiles((cur) => mergeFileUpdates(cur, updates))
        })()
        return prev
      })
    }

    poll()
    const id = window.setInterval(poll, FILE_INGEST_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [workspaceId])

  const onUpload = async (list: FileList | null) => {
    if (!workspaceId || !list?.length) return
    setBusy(true)
    setError(null)
    try {
      const uploaded = await platform.uploadFiles(workspaceId, Array.from(list))
      setFiles((prev) => {
        const ids = new Set(uploaded.map((u) => u.id))
        const rest = prev.filter((f) => !ids.has(f.id))
        return [...uploaded, ...rest]
      })
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
      setFiles((prev) => prev.filter((f) => f.id !== id))
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
        onChange={(e) => {
          void onUpload(e.target.files)
          e.target.value = ''
        }}
      />
      {error && <p className="auth-error">{error}</p>}
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.id}>
            <span className="file-list-main">
              <span className="file-list-name">{f.filename}</span>
              <small className="file-list-meta">{formatBytes(f.size_bytes ?? 0)}</small>
              <FileStatusBadge file={f} />
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void onDelete(f.id)}
            >
              {t('files.delete')}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
