import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatBytes } from '../format'
import {
  FILE_INGEST_POLL_MS,
  isTerminalFileStatus,
  mergeFileUpdates,
} from '../fileIngestion'
import { PageShell } from '../components/PageShell'
import { sendFileToChat } from '../attachBridge'
import { useT } from '../i18n'
import {
  PlatformApiError,
  getStoredWorkspaceId,
  platform,
  type FileCategory,
  type FileTag,
  type PlatformFile,
} from '../platformClient'
import { uploadWithProgress } from '../uploadWithProgress'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

function FileStatusBadge({ file }: { file: PlatformFile }) {
  const t = useT()
  const label = t(`files.status.${file.status}` as 'files.status.pending')
  const tipKey =
    file.status === 'ready'
      ? 'files.status.ready.tip'
      : file.status === 'skipped'
        ? 'files.status.skipped.tip'
        : null
  const tip = tipKey ? t(tipKey) : (file.error_message ?? undefined)
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
        title={tip}
        className={cn(
          file.status === 'ready' && 'bg-emerald-600/20 text-emerald-500 hover:bg-emerald-600/20',
          file.status === 'skipped' && 'bg-muted text-muted-foreground',
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

type SortKey = 'created_at' | 'size' | 'name'

export function FilesPage() {
  const t = useT()
  const workspaceId = getStoredWorkspaceId()
  const [files, setFiles] = useState<PlatformFile[]>([])
  const [categories, setCategories] = useState<FileCategory[]>([])
  const [tags, setTags] = useState<FileTag[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sort, setSort] = useState<SortKey>('created_at')
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [newCategory, setNewCategory] = useState('')
  const [newTag, setNewTag] = useState('')
  const [uploadPct, setUploadPct] = useState<number | null>(null)

  const reload = useCallback(async () => {
    if (!workspaceId) return
    try {
      const [fileRows, catRows, tagRows] = await Promise.all([
        platform.listFiles(workspaceId, {
          sort,
          order,
          category_id: categoryFilter ?? undefined,
          tag: tagFilter ?? undefined,
        }),
        platform.listFileCategories(workspaceId),
        platform.listFileTags(workspaceId),
      ])
      setFiles(fileRows)
      setCategories(catRows)
      setTags(tagRows)
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [workspaceId, sort, order, categoryFilter, tagFilter])

  useEffect(() => {
    void reload()
  }, [reload])

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

  const categoryName = useMemo(() => {
    const m = new Map(categories.map((c) => [c.id, c.name]))
    return (id?: string | null) => (id ? m.get(id) ?? '—' : '—')
  }, [categories])

  const tagName = useMemo(() => {
    const m = new Map(tags.map((tg) => [tg.id, tg.name]))
    return (ids?: string[]) =>
      (ids ?? []).map((id) => m.get(id) ?? id).join(', ') || '—'
  }, [tags])

  const onUpload = async (list: FileList | null, ingest = true) => {
    if (!workspaceId || !list?.length) return
    setBusy(true)
    setError(null)
    setUploadPct(0)
    try {
      const picked = Array.from(list)
      const qs = ingest ? '' : '?ingest=false'
      const uploaded = (await uploadWithProgress(
        `/api/v1/workspaces/${workspaceId}/files${qs}`,
        picked,
        {
          credentials: 'include',
          onProgress: (ev) => setUploadPct(ev.percent),
        },
      )) as PlatformFile[]
      setFiles((prev) => {
        const ids = new Set(uploaded.map((u) => u.id))
        const rest = prev.filter((f) => !ids.has(f.id))
        return [...uploaded, ...rest]
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setUploadPct(null)
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

  const onIngest = async (id: string) => {
    if (!workspaceId) return
    setBusy(true)
    try {
      const updated = await platform.ingestFile(workspaceId, id)
      setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...updated } : f)))
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const addCategory = async () => {
    if (!workspaceId || !newCategory.trim()) return
    try {
      await platform.createFileCategory(workspaceId, newCategory.trim())
      setNewCategory('')
      await reload()
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }

  const addTag = async () => {
    if (!workspaceId || !newTag.trim()) return
    try {
      await platform.createFileTag(workspaceId, newTag.trim())
      setNewTag('')
      await reload()
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }

  if (!workspaceId) {
    return <p className="page-hint">{t('files.noWorkspace')}</p>
  }

  return (
    <PageShell title={t('nav.files')} hint={t('files.hint')} density="wide">
      <div className="files-layout">
        <aside className="files-sidebar">
          <h3>{t('files.categories')}</h3>
          <button
            type="button"
            className={cn('files-filter', !categoryFilter && 'files-filter--active')}
            onClick={() => setCategoryFilter(null)}
          >
            {t('files.all')}
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={cn(
                'files-filter',
                categoryFilter === c.id && 'files-filter--active',
              )}
              onClick={() => setCategoryFilter(c.id)}
            >
              {c.name}
            </button>
          ))}
          <div className="files-sidebar-form">
            <Input
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder={t('files.newCategory')}
            />
            <Button type="button" size="sm" variant="outline" onClick={() => void addCategory()}>
              +
            </Button>
          </div>

          <h3>{t('files.tags')}</h3>
          <div className="files-tag-cloud">
            <button
              type="button"
              className={cn('files-tag', !tagFilter && 'files-tag--active')}
              onClick={() => setTagFilter(null)}
            >
              {t('files.all')}
            </button>
            {tags.map((tg) => (
              <button
                key={tg.id}
                type="button"
                className={cn('files-tag', tagFilter === tg.name && 'files-tag--active')}
                onClick={() => setTagFilter(tg.name)}
              >
                {tg.name}
              </button>
            ))}
          </div>
          <div className="files-sidebar-form">
            <Input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              placeholder={t('files.newTag')}
            />
            <Button type="button" size="sm" variant="outline" onClick={() => void addTag()}>
              +
            </Button>
          </div>
        </aside>

        <div className="files-main">
          <div className="files-toolbar">
            <label>
              {t('files.sort')}
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
              >
                <option value="created_at">{t('files.sort.date')}</option>
                <option value="size">{t('files.sort.size')}</option>
                <option value="name">{t('files.sort.name')}</option>
              </select>
            </label>
            <label>
              {t('files.order')}
              <select
                value={order}
                onChange={(e) => setOrder(e.target.value as 'asc' | 'desc')}
              >
                <option value="desc">{t('files.order.desc')}</option>
                <option value="asc">{t('files.order.asc')}</option>
              </select>
            </label>
            <label className="files-upload-btn" title={t('files.upload.tip')}>
              <span>{t('files.upload')}</span>
              <input
                type="file"
                multiple
                accept=".pdf,.docx,.xlsx,.pptx,.txt,.md"
                disabled={busy}
                hidden
                onChange={(e) => {
                  void onUpload(e.target.files, true)
                  e.target.value = ''
                }}
              />
            </label>
            <label
              className="files-upload-btn files-upload-btn--secondary"
              title={t('files.uploadStoreOnly.tip')}
            >
              <span>{t('files.uploadStoreOnly')}</span>
              <input
                type="file"
                multiple
                accept=".pdf,.docx,.xlsx,.pptx,.txt,.md"
                disabled={busy}
                hidden
                onChange={(e) => {
                  void onUpload(e.target.files, false)
                  e.target.value = ''
                }}
              />
            </label>
            {uploadPct != null && (
              <span className="files-upload-progress">
                {t('files.uploadProgress', { pct: uploadPct })}
              </span>
            )}
          </div>

          {error && <p className="auth-error">{error}</p>}

          <div className="files-table-wrap">
            <table className="files-table">
              <thead>
                <tr>
                  <th>{t('files.col.name')}</th>
                  <th>{t('files.col.size')}</th>
                  <th>{t('files.col.category')}</th>
                  <th>{t('files.col.tags')}</th>
                  <th>{t('files.col.origin')}</th>
                  <th>{t('files.col.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id}>
                    <td>{f.filename}</td>
                    <td>{formatBytes(f.size_bytes ?? 0)}</td>
                    <td>{categoryName(f.category_id)}</td>
                    <td>{tagName(f.tag_ids)}</td>
                    <td>{f.origin ?? 'platform'}</td>
                    <td>
                      <FileStatusBadge file={f} />
                    </td>
                    <td className="files-row-actions">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          sendFileToChat({
                            name: f.filename,
                            path: f.storage_key ?? `uploads/${f.filename}`,
                            size: f.size_bytes ?? 0,
                          })
                        }
                      >
                        {t('files.sendToChat')}
                      </Button>
                      {f.status === 'skipped' && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          title={t('files.ingest.tip')}
                          onClick={() => void onIngest(f.id)}
                        >
                          {t('files.ingest')}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void onDelete(f.id)}
                      >
                        {t('files.delete')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {files.length === 0 && (
              <p className="page-hint files-empty">{t('files.empty')}</p>
            )}
          </div>
        </div>
      </div>
    </PageShell>
  )
}
