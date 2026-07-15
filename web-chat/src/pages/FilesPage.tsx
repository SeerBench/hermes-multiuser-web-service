import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { Folder, Plus } from 'lucide-react'
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
  type FileFolder,
  type FileTag,
  type PlatformFile,
} from '../platformClient'
import { routeHref } from '../routing'
import { uploadWithProgress } from '../uploadWithProgress'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

/** Tab filter: all = no kind query; otherwise mirror API kind. */
export type FilesKindTab = 'all' | 'document' | 'image'

type SortKey = 'created_at' | 'size' | 'name'

const DOC_ACCEPT = '.pdf,.docx,.xlsx,.pptx,.txt,.md'
const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg'
const ALL_ACCEPT = `${DOC_ACCEPT},${IMAGE_ACCEPT}`
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

export function filesListKindParam(
  kind: FilesKindTab,
): 'image' | 'document' | undefined {
  return kind === 'all' ? undefined : kind
}

export function isImageFilename(name: string): boolean {
  return IMAGE_EXT.test(name)
}

function uploadAcceptForTab(kind: FilesKindTab): string {
  if (kind === 'image') return IMAGE_ACCEPT
  if (kind === 'document') return DOC_ACCEPT
  return ALL_ACCEPT
}

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
          file.status === 'ready' &&
            'bg-emerald-600/20 text-emerald-500 hover:bg-emerald-600/20',
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

function formatCreatedAt(ts: number): string {
  try {
    return new Date(ts * 1000).toLocaleString()
  } catch {
    return '—'
  }
}

export function FilesPage() {
  const t = useT()
  const workspaceId = getStoredWorkspaceId()
  const [kind, setKind] = useState<FilesKindTab>('all')
  const [files, setFiles] = useState<PlatformFile[]>([])
  const [folders, setFolders] = useState<FileFolder[]>([])
  const [tags, setTags] = useState<FileTag[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sort, setSort] = useState<SortKey>('created_at')
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  /** null = root; string = current folder */
  const [folderId, setFolderId] = useState<string | null>(null)
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [pendingDeleteFolder, setPendingDeleteFolder] = useState<{
    id: string
    name: string
    fileCount: number
    folderCount: number
  } | null>(null)

  const storeUploadRef = useRef<HTMLInputElement>(null)
  const ingestUploadRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(async () => {
    if (!workspaceId) return
    // 分请求加载：folders/tags 失败时不应吞掉文件列表（旧服务端无 file-folders 会 404）
    let fileError: string | null = null
    let secondaryError: string | null = null
    try {
      const fileRows = await platform.listFiles(workspaceId, {
        sort,
        order,
        kind: filesListKindParam(kind),
        folder_id: folderId,
      })
      setFiles(fileRows)
    } catch (err) {
      setFiles([])
      fileError = err instanceof PlatformApiError ? err.message : String(err)
    }
    try {
      setFolders(await platform.listFileFolders(workspaceId))
    } catch (err) {
      setFolders([])
      // 路由缺失（旧 platform-api）时不盖住已加载的文件列表
      if (!(err instanceof PlatformApiError && err.status === 404)) {
        secondaryError =
          err instanceof PlatformApiError ? err.message : String(err)
      }
    }
    try {
      setTags(await platform.listFileTags(workspaceId))
    } catch {
      setTags([])
    }
    setError(fileError ?? secondaryError)
  }, [workspaceId, sort, order, kind, folderId])

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

  const childFolders = useMemo(() => {
    const rows = folders.filter((f) => (f.parent_id ?? null) === folderId)
    return [...rows].sort((a, b) => a.name.localeCompare(b.name))
  }, [folders, folderId])

  const currentFolder = useMemo(
    () => (folderId ? folders.find((f) => f.id === folderId) : null),
    [folders, folderId],
  )

  const breadcrumb = useMemo(() => {
    const path: FileFolder[] = []
    let cursor = currentFolder
    while (cursor) {
      path.unshift(cursor)
      cursor = cursor.parent_id
        ? folders.find((f) => f.id === cursor!.parent_id)
        : undefined
    }
    return path
  }, [currentFolder, folders])

  const showStatusCol = kind !== 'image'
  const accept = uploadAcceptForTab(kind)
  const listEmpty = childFolders.length === 0 && files.length === 0

  const onUpload = async (list: FileList | null, ingest = true) => {
    if (!workspaceId || !list?.length) return
    setBusy(true)
    setError(null)
    setUploadPct(0)
    try {
      const picked = Array.from(list)
      const q = new URLSearchParams()
      if (!ingest) q.set('ingest', 'false')
      if (folderId) q.set('folder_id', folderId)
      const qs = q.toString()
      const uploaded = (await uploadWithProgress(
        `/api/v1/workspaces/${workspaceId}/files${qs ? `?${qs}` : ''}`,
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
      await reload()
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

  const createFolder = async () => {
    if (!workspaceId || !newFolderName.trim()) return
    try {
      await platform.createFileFolder(workspaceId, newFolderName.trim(), folderId)
      setNewFolderName('')
      setFolderDialogOpen(false)
      await reload()
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }

  const commitRenameFolder = async () => {
    if (!workspaceId || !renamingFolderId || !renameValue.trim()) {
      setRenamingFolderId(null)
      return
    }
    try {
      await platform.renameFileFolder(
        workspaceId,
        renamingFolderId,
        renameValue.trim(),
      )
      setRenamingFolderId(null)
      await reload()
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }

  const onDeleteFolder = async (id: string, force = false) => {
    if (!workspaceId) return
    setBusy(true)
    setError(null)
    try {
      await platform.deleteFileFolder(workspaceId, id, force)
      setPendingDeleteFolder(null)
      setFolderId((cur) => {
        if (!cur) return null
        if (cur === id) return null
        let walk: string | null = cur
        const seen = new Set<string>()
        while (walk) {
          if (walk === id) return null
          if (seen.has(walk)) break
          seen.add(walk)
          walk = folders.find((f) => f.id === walk)?.parent_id ?? null
        }
        return cur
      })
      await reload()
    } catch (err) {
      if (
        !force &&
        err instanceof PlatformApiError &&
        err.status === 409 &&
        typeof err.detail === 'object' &&
        err.detail &&
        (err.detail as { code?: string }).code === 'folder_not_empty'
      ) {
        const d = err.detail as {
          file_count?: number
          folder_count?: number
        }
        const folder = folders.find((f) => f.id === id)
        setPendingDeleteFolder({
          id,
          name: folder?.name ?? id,
          fileCount: d.file_count ?? 0,
          folderCount: d.folder_count ?? 0,
        })
      } else {
        setError(err instanceof PlatformApiError ? err.message : String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  const requestDeleteFolder = (id: string) => {
    void onDeleteFolder(id, false)
  }

  const toggleFileTag = async (file: PlatformFile, tagId: string) => {
    if (!workspaceId) return
    const current = new Set(file.tag_ids ?? [])
    if (current.has(tagId)) current.delete(tagId)
    else current.add(tagId)
    try {
      const updated = await platform.patchFile(workspaceId, file.id, {
        tag_ids: [...current],
      })
      setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, ...updated } : f)))
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }

  const moveFile = async (fileId: string, targetFolderId: string) => {
    if (!workspaceId) return
    try {
      const updated = await platform.patchFile(workspaceId, fileId, {
        folder_id: targetFolderId === '__root__' ? null : targetFolderId,
      })
      const stays =
        (folderId == null && !updated.folder_id) ||
        updated.folder_id === folderId
      setFiles((prev) =>
        stays
          ? prev.map((f) => (f.id === fileId ? { ...f, ...updated } : f))
          : prev.filter((f) => f.id !== fileId),
      )
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }

  if (!workspaceId) {
    return <p className="page-hint">{t('files.noWorkspace')}</p>
  }

  return (
    <PageShell
      title={t('nav.files')}
      hint={t('files.hint')}
      density="reading"
      constrainWidth={false}
    >
      {/* Tabs 左 + 新建/标签 右 */}
      <div className="files-tabs-bar">
        <Tabs
          value={kind}
          onValueChange={(v) => setKind(v as FilesKindTab)}
          className="files-kind-tabs"
        >
          <TabsList>
            <TabsTrigger value="all">{t('files.kind.all')}</TabsTrigger>
            <TabsTrigger value="document">{t('files.kind.documents')}</TabsTrigger>
            <TabsTrigger value="image">{t('files.kind.images')}</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="files-tabs-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="sm">
                <Plus className="size-4" aria-hidden />
                {t('files.new')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[12rem]">
              <DropdownMenuItem
                onSelect={() => {
                  setNewFolderName('')
                  setFolderDialogOpen(true)
                }}
              >
                {t('files.new.folder')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  // 延后一拍，避免菜单关闭抢焦点导致 file picker 被挡
                  window.setTimeout(() => storeUploadRef.current?.click(), 0)
                }}
              >
                {t('files.new.upload')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  window.setTimeout(() => ingestUploadRef.current?.click(), 0)
                }}
              >
                {t('files.new.uploadIngest')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              window.location.hash = routeHref('file-tags')
            }}
          >
            {t('files.tags')}
          </Button>
        </div>
      </div>

      <input
        ref={storeUploadRef}
        type="file"
        multiple
        accept={accept}
        disabled={busy}
        hidden
        onChange={(e) => {
          void onUpload(e.target.files, false)
          e.target.value = ''
        }}
      />
      <input
        ref={ingestUploadRef}
        type="file"
        multiple
        accept={kind === 'image' ? IMAGE_ACCEPT : DOC_ACCEPT}
        disabled={busy}
        hidden
        onChange={(e) => {
          void onUpload(e.target.files, true)
          e.target.value = ''
        }}
      />

      <div className="files-main">
        <div className="files-toolbar">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                {breadcrumb.length === 0 ? (
                  <BreadcrumbPage>{t('files.folders.root')}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink
                    asChild
                  >
                    <button type="button" onClick={() => setFolderId(null)}>
                      {t('files.folders.root')}
                    </button>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {breadcrumb.map((f, i) => {
                const isLast = i === breadcrumb.length - 1
                return (
                  <Fragment key={f.id}>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      {isLast ? (
                        <BreadcrumbPage>{f.name}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink asChild>
                          <button type="button" onClick={() => setFolderId(f.id)}>
                            {f.name}
                          </button>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                )
              })}
            </BreadcrumbList>
          </Breadcrumb>

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
                <th>{t('files.col.created')}</th>
                <th>{t('files.col.tags')}</th>
                <th>{t('files.col.origin')}</th>
                {showStatusCol && <th>{t('files.col.status')}</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {/* 当前目录下的子文件夹与文件同表展示 */}
              {childFolders.map((folder) => (
                <tr key={`folder-${folder.id}`} className="files-row--folder">
                  <td>
                    {renamingFolderId === folder.id ? (
                      <div className="files-inline-rename">
                        <Input
                          value={renameValue}
                          autoFocus
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void commitRenameFolder()
                            if (e.key === 'Escape') setRenamingFolderId(null)
                          }}
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void commitRenameFolder()}
                        >
                          ✓
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="files-folder-link"
                        onClick={() => setFolderId(folder.id)}
                      >
                        <Folder className="size-4 shrink-0" aria-hidden />
                        <span>{folder.name}</span>
                      </button>
                    )}
                  </td>
                  <td>—</td>
                  <td className="files-col-date">
                    {formatCreatedAt(folder.created_at)}
                  </td>
                  <td>—</td>
                  <td>{t('files.folders')}</td>
                  {showStatusCol && <td>—</td>}
                  <td className="files-row-actions">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      title={t('files.folders.rename')}
                      onClick={() => {
                        setRenamingFolderId(folder.id)
                        setRenameValue(folder.name)
                      }}
                    >
                      {t('files.folders.rename')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => requestDeleteFolder(folder.id)}
                    >
                      {t('files.delete')}
                    </Button>
                  </td>
                </tr>
              ))}

              {files.map((f) => {
                const image = isImageFilename(f.filename)
                return (
                  <tr key={f.id}>
                    <td>{f.filename}</td>
                    <td>{formatBytes(f.size_bytes ?? 0)}</td>
                    <td className="files-col-date">
                      {formatCreatedAt(f.created_at)}
                    </td>
                    <td>
                      <div className="files-row-tags">
                        {tags.map((tg) => {
                          const on = (f.tag_ids ?? []).includes(tg.id)
                          return (
                            <button
                              key={tg.id}
                              type="button"
                              className={cn(
                                'files-tag',
                                on && 'files-tag--active',
                              )}
                              title={t('files.tags.toggle')}
                              onClick={() => void toggleFileTag(f, tg.id)}
                            >
                              {tg.name}
                            </button>
                          )
                        })}
                        {tags.length === 0 && (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    </td>
                    <td>{f.origin ?? 'platform'}</td>
                    {showStatusCol && (
                      <td>{image ? '—' : <FileStatusBadge file={f} />}</td>
                    )}
                    <td className="files-row-actions">
                      <select
                        className="files-move-select"
                        defaultValue=""
                        aria-label={t('files.move')}
                        onChange={(e) => {
                          const v = e.target.value
                          e.target.value = ''
                          if (v) void moveFile(f.id, v)
                        }}
                      >
                        <option value="" disabled>
                          {t('files.move')}
                        </option>
                        <option value="__root__">
                          {t('files.folders.root')}
                        </option>
                        {folders.map((folder) => (
                          <option key={folder.id} value={folder.id}>
                            {folder.name}
                          </option>
                        ))}
                      </select>
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
                      {!image && f.status === 'skipped' && (
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
                )
              })}
            </tbody>
          </table>
          {listEmpty && (
            <p className="page-hint files-empty">{t('files.empty')}</p>
          )}
        </div>
      </div>

      <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('files.new.folder')}</DialogTitle>
            <DialogDescription>{t('files.folders.new.hint')}</DialogDescription>
          </DialogHeader>
          <Input
            value={newFolderName}
            autoFocus
            placeholder={t('files.folders.new')}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createFolder()
            }}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setFolderDialogOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={!newFolderName.trim()}
              onClick={() => void createFolder()}
            >
              {t('common.ok')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDeleteFolder != null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteFolder(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('files.folders.deleteWarn.title')}</DialogTitle>
            <DialogDescription>
              {pendingDeleteFolder
                ? t('files.folders.deleteWarn.body', {
                    name: pendingDeleteFolder.name,
                    files: pendingDeleteFolder.fileCount,
                    folders: pendingDeleteFolder.folderCount,
                  })
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingDeleteFolder(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || !pendingDeleteFolder}
              onClick={() => {
                if (pendingDeleteFolder) {
                  void onDeleteFolder(pendingDeleteFolder.id, true)
                }
              }}
            >
              {t('files.folders.deleteWarn.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
