import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { PageShell } from '../components/PageShell'
import { useT } from '../i18n'
import {
  PlatformApiError,
  getStoredWorkspaceId,
  platform,
  type FileTag,
  type PlatformFile,
} from '../platformClient'
import { routeHref } from '../routing'
import { toggleFileTagId } from '../filesListHelpers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * 标签管理独立页：创建/删除标签，并为文件勾选标签。
 */
export function FileTagsPage() {
  const t = useT()
  const workspaceId = getStoredWorkspaceId()
  const [tags, setTags] = useState<FileTag[]>([])
  const [files, setFiles] = useState<PlatformFile[]>([])
  const [newTag, setNewTag] = useState('')
  const [busy, setBusy] = useState(false)
  /** 当前聚焦打标签的文件；null 时展示文件列表供选择 */
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!workspaceId) return
    try {
      const [tagRows, fileRows] = await Promise.all([
        platform.listFileTags(workspaceId),
        platform.listFiles(workspaceId, { sort: 'created_at', order: 'desc' }),
      ])
      setTags(tagRows)
      setFiles(fileRows)
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [workspaceId])

  useEffect(() => {
    void reload()
  }, [reload])

  const selectedFile =
    selectedFileId != null
      ? files.find((f) => f.id === selectedFileId) ?? null
      : null

  const addTag = async () => {
    if (!workspaceId || !newTag.trim()) return
    setBusy(true)
    try {
      await platform.createFileTag(workspaceId, newTag.trim())
      setNewTag('')
      await reload()
      toast.success(t('files.tags.toast.created'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const removeTag = async (tagId: string) => {
    if (!workspaceId) return
    setBusy(true)
    try {
      await platform.deleteFileTag(workspaceId, tagId)
      await reload()
      toast.success(t('files.tags.toast.deleted'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleFileTag = async (file: PlatformFile, tagId: string) => {
    if (!workspaceId) return
    try {
      const updated = await platform.patchFile(workspaceId, file.id, {
        tag_ids: toggleFileTagId(file.tag_ids, tagId),
      })
      setFiles((prev) =>
        prev.map((f) => (f.id === file.id ? { ...f, ...updated } : f)),
      )
      toast.success(t('files.tags.toast.updated'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    }
  }

  if (!workspaceId) {
    return <p className="page-hint">{t('files.noWorkspace')}</p>
  }

  return (
    <PageShell
      title={t('files.tags.pageTitle')}
      hint={t('files.tags.pageHint')}
      density="reading"
      constrainWidth={false}
    >
      <div className="files-tags-page-toolbar">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            window.location.hash = routeHref('files')
          }}
        >
          <ArrowLeft className="size-4" aria-hidden />
          {t('files.tags.back')}
        </Button>
      </div>

      <section className="files-tags-section">
        <h3 className="files-tags-section-title">{t('files.tags.manage')}</h3>
        <div className="files-sidebar-form files-tags-create">
          <Input
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            placeholder={t('files.newTag')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addTag()
            }}
          />
          <Button
            type="button"
            size="sm"
            disabled={busy || !newTag.trim()}
            onClick={() => void addTag()}
          >
            {t('files.tags.create')}
          </Button>
        </div>

        {tags.length === 0 ? (
          <p className="page-hint">{t('files.tags.empty')}</p>
        ) : (
          <ul className="files-tags-list">
            {tags.map((tg) => (
              <li key={tg.id} className="files-tags-list-item">
                <span className="files-tags-list-name">{tg.name}</span>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t('files.tags.deleteLabel', { name: tg.name })}
                  title={t('files.tags.deleteLabel', { name: tg.name })}
                  onClick={() => void removeTag(tg.id)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="files-tags-section">
        <h3 className="files-tags-section-title">{t('files.tags.assign')}</h3>
        <p className="page-hint files-tags-assign-hint">
          {t('files.tags.assign.hint')}
        </p>

        {selectedFile ? (
          <div className="files-tags-assign-panel">
            <div className="files-tags-assign-header">
              <strong title={selectedFile.filename}>{selectedFile.filename}</strong>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setSelectedFileId(null)}
              >
                {t('files.tags.pickOther')}
              </Button>
            </div>
            <div className="files-row-tags files-tags-pick">
              {tags.length === 0 ? (
                <span className="text-muted-foreground">
                  {t('files.tags.empty')}
                </span>
              ) : (
                tags.map((tg) => {
                  const on = (selectedFile.tag_ids ?? []).includes(tg.id)
                  return (
                    <button
                      key={tg.id}
                      type="button"
                      className={cn('files-tag', on && 'files-tag--active')}
                      title={t('files.tags.toggle')}
                      onClick={() => void toggleFileTag(selectedFile, tg.id)}
                    >
                      {tg.name}
                    </button>
                  )
                })
              )}
            </div>
          </div>
        ) : files.length === 0 ? (
          <p className="page-hint">{t('files.empty')}</p>
        ) : (
          <ul className="files-tags-file-pick">
            {files.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className="files-filter"
                  onClick={() => setSelectedFileId(f.id)}
                >
                  {f.filename}
                  {(f.tag_ids?.length ?? 0) > 0 && (
                    <span className="files-tags-file-count">
                      {t('files.tags.count', { n: f.tag_ids!.length })}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageShell>
  )
}
