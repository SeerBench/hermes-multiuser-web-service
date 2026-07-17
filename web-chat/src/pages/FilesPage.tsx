import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { Folder, MoreHorizontal, Plus, Search } from 'lucide-react'
import { toast } from 'sonner'
import { isWorkspaceFilePreviewable } from '../attachmentPreview'
import { formatBytes } from '../format'
import {
  FILE_INGEST_POLL_MS,
  isTerminalFileStatus,
  mergeFileUpdates,
} from '../fileIngestion'
import { FilePreviewDrawer, type PreviewableFile } from '../components/FilePreviewDrawer'
import { PageShell } from '../components/PageShell'
import { sendFileToChat } from '../attachBridge'
import {
  assignedTagsForFile,
  buildFilesListRows,
  canCiteFileToChat,
  fileOriginLabelKey,
  filesListPageCount,
  filesPaginationItems,
  filterFilesListRows,
  findTagByName,
  flattenFolderTree,
  folderContentCount,
  sliceFilesListPage,
  toggleFileTagId,
} from '../filesListHelpers'
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
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
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
  const [tagFilter, setTagFilter] = useState('')
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
  /** 文件行：移动 / 重命名 / 删除 弹窗目标 */
  const [movingFile, setMovingFile] = useState<PlatformFile | null>(null)
  const [moveTargetId, setMoveTargetId] = useState<string>('__root__')
  const [renamingFile, setRenamingFile] = useState<PlatformFile | null>(null)
  const [renameFileValue, setRenameFileValue] = useState('')
  const [deletingFile, setDeletingFile] = useState<PlatformFile | null>(null)
  const [taggingFile, setTaggingFile] = useState<PlatformFile | null>(null)
  const [newManagedTag, setNewManagedTag] = useState('')
  const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [listPage, setListPage] = useState(1)
  const [nameQuery, setNameQuery] = useState('')
  const [trySearchOpen, setTrySearchOpen] = useState(false)
  const [trySearchQuery, setTrySearchQuery] = useState('')
  const [trySearchBusy, setTrySearchBusy] = useState(false)
  const [trySearchHits, setTrySearchHits] = useState<
    {
      chunk_id: string
      file_id: string
      filename: string
      score: number
      content?: string
    }[]
  >([])

  const storeUploadRef = useRef<HTMLInputElement>(null)
  const ingestUploadRef = useRef<HTMLInputElement>(null)

  const folderTree = useMemo(() => flattenFolderTree(folders), [folders])

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
        tag: tagFilter || undefined,
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
  }, [workspaceId, sort, order, kind, folderId, tagFilter])

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

  const filteredRows = useMemo(() => {
    const rows = buildFilesListRows(childFolders, files)
    return filterFilesListRows(rows, nameQuery)
  }, [childFolders, files, nameQuery])

  const totalPages = filesListPageCount(filteredRows.length)
  const safePage = Math.min(listPage, totalPages)
  const pageRows = useMemo(
    () => sliceFilesListPage(filteredRows, safePage),
    [filteredRows, safePage],
  )
  const pageItems = useMemo(
    () => filesPaginationItems(safePage, totalPages),
    [safePage, totalPages],
  )
  const listEmpty = filteredRows.length === 0

  useEffect(() => {
    setListPage(1)
  }, [folderId, kind, tagFilter, nameQuery, sort, order])

  useEffect(() => {
    if (listPage !== safePage) setListPage(safePage)
  }, [listPage, safePage])

  const runTrySearch = async () => {
    if (!workspaceId || !trySearchQuery.trim()) return
    setTrySearchBusy(true)
    try {
      const res = await platform.searchKnowledge(
        workspaceId,
        trySearchQuery.trim(),
        8,
      )
      setTrySearchHits(res.results ?? [])
      if (!(res.results ?? []).length) {
        toast.message(t('files.trySearch.empty'))
      }
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setTrySearchBusy(false)
    }
  }

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
      toast.success(t('files.toast.uploaded'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
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
      toast.success(t('files.toast.deleted'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
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
      toast.success(t('files.toast.ingested'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
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
      toast.success(t('files.toast.folderCreated'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
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
      toast.success(t('files.toast.folderRenamed'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
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
      toast.success(t('files.toast.folderDeleted'))
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
        toast.error(err instanceof PlatformApiError ? err.message : String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  const requestDeleteFolder = (id: string) => {
    void onDeleteFolder(id, false)
  }

  const moveFile = async (fileId: string, targetFolderId: string) => {
    if (!workspaceId) return
    setBusy(true)
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
      setMovingFile(null)
      toast.success(t('files.toast.moved'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const commitRenameFile = async () => {
    if (!workspaceId || !renamingFile || !renameFileValue.trim()) return
    setBusy(true)
    try {
      const updated = await platform.patchFile(workspaceId, renamingFile.id, {
        filename: renameFileValue.trim(),
      })
      setFiles((prev) =>
        prev.map((f) => (f.id === renamingFile.id ? { ...f, ...updated } : f)),
      )
      setRenamingFile(null)
      toast.success(t('files.toast.renamed'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const confirmDeleteFile = async () => {
    if (!deletingFile) return
    await onDelete(deletingFile.id)
    setDeletingFile(null)
  }

  const toggleTagForFile = async (file: PlatformFile, tagId: string) => {
    if (!workspaceId) return
    setBusy(true)
    try {
      const updated = await platform.patchFile(workspaceId, file.id, {
        tag_ids: toggleFileTagId(file.tag_ids, tagId),
      })
      setFiles((prev) =>
        prev.map((row) => (row.id === file.id ? { ...row, ...updated } : row)),
      )
      setTaggingFile((current) =>
        current?.id === file.id ? { ...current, ...updated } : current,
      )
      toast.success(t('files.tags.toast.updated'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const createAndAssignTag = async () => {
    if (!workspaceId || !taggingFile) return
    const name = newManagedTag.trim()
    if (!name) return

    setBusy(true)
    try {
      // 前后端都按忽略大小写的名称去重；已有标签直接复用并分配。
      const tag =
        findTagByName(tags, name) ??
        (await platform.createFileTag(workspaceId, name))
      setTags((prev) =>
        prev.some((item) => item.id === tag.id) ? prev : [...prev, tag],
      )

      if (!(taggingFile.tag_ids ?? []).includes(tag.id)) {
        const updated = await platform.patchFile(workspaceId, taggingFile.id, {
          tag_ids: [...(taggingFile.tag_ids ?? []), tag.id],
        })
        setFiles((prev) =>
          prev.map((row) =>
            row.id === taggingFile.id ? { ...row, ...updated } : row,
          ),
        )
        setTaggingFile((current) =>
          current?.id === taggingFile.id ? { ...current, ...updated } : current,
        )
      }
      setNewManagedTag('')
      toast.success(t('files.tags.toast.updated'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
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
      {/* 类型 Tab + 搜索 + 新建 / 标签 / 试搜 */}
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
          <div className="files-search-field">
            <Search className="size-3.5 shrink-0 opacity-50" aria-hidden />
            <Input
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              placeholder={t('files.search.placeholder')}
              aria-label={t('files.search.placeholder')}
              className="h-8"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="sm">
                <Plus className="size-4" aria-hidden />
                {t('files.new')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
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
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setTrySearchHits([])
              setTrySearchQuery('')
              setTrySearchOpen(true)
            }}
          >
            {t('files.trySearch')}
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

          <div className="files-toolbar-sort">
            <label>
              {t('files.tags.filter')}
              <select
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
              >
                <option value="">{t('files.tags.filterAll')}</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.name}>
                    {tag.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('files.sort')}
              <select
                value={`${sort}:${order}`}
                onChange={(e) => {
                  const [s, o] = e.target.value.split(':') as [SortKey, 'asc' | 'desc']
                  setSort(s)
                  setOrder(o)
                }}
              >
                <option value="created_at:desc">
                  {t('files.sort.date')} · {t('files.order.desc')}
                </option>
                <option value="created_at:asc">
                  {t('files.sort.date')} · {t('files.order.asc')}
                </option>
                <option value="name:asc">
                  {t('files.sort.name')} · {t('files.order.asc')}
                </option>
                <option value="name:desc">
                  {t('files.sort.name')} · {t('files.order.desc')}
                </option>
                <option value="size:desc">
                  {t('files.sort.size')} · {t('files.order.desc')}
                </option>
                <option value="size:asc">
                  {t('files.sort.size')} · {t('files.order.asc')}
                </option>
              </select>
            </label>
            {uploadPct != null && (
              <span className="files-upload-progress">
                {t('files.uploadProgress', { pct: uploadPct })}
              </span>
            )}
          </div>
        </div>

        {error && <p className="auth-error">{error}</p>}

        <div className="files-table-wrap">
          <table className="files-table">
            <thead>
              <tr>
                <th>{t('files.col.name')}</th>
                <th>{t('files.col.size')}</th>
                <th>{t('files.col.created')}</th>
                <th>{t('files.col.origin')}</th>
                {showStatusCol && <th>{t('files.col.status')}</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {/* 分页后的文件夹 + 文件行；文件夹操作与文件统一为 ⋯ 菜单 */}
              {pageRows.map((row) => {
                if (row.kind === 'folder') {
                  const folder = row.folder
                  return (
                    <tr
                      key={`folder-${folder.id}`}
                      className="files-row--folder"
                    >
                      <td className="files-name-cell">
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
                            <span className="files-folder-name">
                              {folder.name}
                              <span className="files-folder-count">
                                {t('files.folders.fileCount', {
                                  n: folderContentCount(folder, folders),
                                })}
                              </span>
                            </span>
                          </button>
                        )}
                      </td>
                      <td className="files-col-size">—</td>
                      <td className="files-col-date">
                        {formatCreatedAt(folder.created_at)}
                      </td>
                      <td className="files-col-origin">—</td>
                      {showStatusCol && <td>—</td>}
                      <td>
                        <div className="files-row-actions">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                aria-label={t('files.more')}
                              >
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-40">
                              <DropdownMenuItem
                                onSelect={() => {
                                  setRenamingFolderId(folder.id)
                                  setRenameValue(folder.name)
                                }}
                              >
                                {t('files.folders.rename')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                disabled={busy}
                                onSelect={() => requestDeleteFolder(folder.id)}
                              >
                                {t('files.delete')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </td>
                    </tr>
                  )
                }

                const f = row.file
                const image = isImageFilename(f.filename)
                const fileTags = assignedTagsForFile(tags, f.tag_ids)
                const citeable = canCiteFileToChat(f)
                const previewable = isWorkspaceFilePreviewable(f.filename)
                return (
                  <tr key={f.id}>
                    <td className="files-name-cell">
                      <div className="files-name-stack">
                        {previewable ? (
                          <button
                            type="button"
                            className="files-name-link"
                            title={t('attach.preview.clickHint')}
                            onClick={() => {
                              setPreviewFile({
                                fileId: f.id,
                                name: f.filename,
                              })
                              setPreviewOpen(true)
                            }}
                          >
                            {f.filename}
                          </button>
                        ) : (
                          <span className="files-name-text">{f.filename}</span>
                        )}
                        {fileTags.length > 0 && (
                          <div className="files-row-tags">
                            {fileTags.map((tg) => (
                              <Badge
                                key={tg.id}
                                variant="secondary"
                                className="files-name-tag"
                              >
                                {tg.name}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="files-col-size">
                      {formatBytes(f.size_bytes ?? 0)}
                    </td>
                    <td className="files-col-date">
                      {formatCreatedAt(f.created_at)}
                    </td>
                    <td className="files-col-origin">
                      {t(fileOriginLabelKey(f.origin))}
                    </td>
                    {showStatusCol && (
                      <td>{image ? '—' : <FileStatusBadge file={f} />}</td>
                    )}
                    <td>
                      <div className="files-row-actions">
                        {citeable && (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              sendFileToChat({
                                name: f.filename,
                                path: f.storage_key ?? `uploads/${f.filename}`,
                                size: f.size_bytes ?? 0,
                                fileId: f.id,
                                mimeType: f.mime_type,
                              })
                            }
                          >
                            {t('files.sendToChat')}
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t('files.more')}
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-40">
                            <DropdownMenuItem
                              onSelect={() => {
                                setNewManagedTag('')
                                setTaggingFile(f)
                              }}
                            >
                              {t('files.tags.manageFile')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                setMoveTargetId(f.folder_id ?? '__root__')
                                setMovingFile(f)
                              }}
                            >
                              {t('files.move')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                setRenameFileValue(f.filename)
                                setRenamingFile(f)
                              }}
                            >
                              {t('files.rename')}
                            </DropdownMenuItem>
                            {!image && f.status === 'skipped' && (
                              <DropdownMenuItem
                                disabled={busy}
                                onSelect={() => void onIngest(f.id)}
                              >
                                {t('files.ingest')}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={busy}
                              onSelect={() => setDeletingFile(f)}
                            >
                              {t('files.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {listEmpty && (
            <p className="page-hint files-empty">{t('files.empty')}</p>
          )}
          {!listEmpty && totalPages > 1 && (
            <Pagination className="files-pagination">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    disabled={safePage <= 1}
                    onClick={() => setListPage((p) => Math.max(1, p - 1))}
                  >
                    {t('files.pagination.prev')}
                  </PaginationPrevious>
                </PaginationItem>
                {pageItems.map((item, idx) =>
                  item < 0 ? (
                    <PaginationItem key={`ellipsis-${idx}`}>
                      <PaginationEllipsis />
                    </PaginationItem>
                  ) : (
                    <PaginationItem key={item}>
                      <PaginationLink
                        isActive={item === safePage}
                        onClick={() => setListPage(item)}
                      >
                        {item}
                      </PaginationLink>
                    </PaginationItem>
                  ),
                )}
                <PaginationItem>
                  <PaginationNext
                    disabled={safePage >= totalPages}
                    onClick={() =>
                      setListPage((p) => Math.min(totalPages, p + 1))
                    }
                  >
                    {t('files.pagination.next')}
                  </PaginationNext>
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </div>
      </div>

      <FilePreviewDrawer
        open={previewOpen}
        onOpenChange={(open) => {
          setPreviewOpen(open)
          if (!open) setPreviewFile(null)
        }}
        workspaceId={workspaceId}
        file={previewFile}
      />

      {/* 知识库试搜：验证已索引文档能否被检索到 */}
      <Dialog
        open={trySearchOpen}
        onOpenChange={(open) => {
          setTrySearchOpen(open)
          if (!open) {
            setTrySearchHits([])
            setTrySearchQuery('')
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('files.trySearch')}</DialogTitle>
            <DialogDescription>{t('files.trySearch.hint')}</DialogDescription>
          </DialogHeader>
          <div className="files-try-search-form">
            <Input
              value={trySearchQuery}
              autoFocus
              placeholder={t('files.trySearch.placeholder')}
              onChange={(e) => setTrySearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runTrySearch()
              }}
            />
            <Button
              type="button"
              disabled={trySearchBusy || !trySearchQuery.trim()}
              onClick={() => void runTrySearch()}
            >
              {trySearchBusy ? t('files.trySearch.running') : t('files.trySearch.run')}
            </Button>
          </div>
          {trySearchHits.length > 0 && (
            <ul className="files-try-search-hits">
              {trySearchHits.map((hit) => (
                <li key={hit.chunk_id} className="files-try-search-hit">
                  <div className="files-try-search-hit-head">
                    <span className="files-try-search-hit-name">
                      {hit.filename}
                    </span>
                    <span className="files-try-search-hit-score">
                      {t('files.trySearch.score', {
                        score: hit.score.toFixed(3),
                      })}
                    </span>
                  </div>
                  {hit.content ? (
                    <p className="files-try-search-hit-snippet">{hit.content}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setTrySearchOpen(false)}
            >
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {/* 移动到文件夹（文件树） */}
      <Dialog
        open={movingFile != null}
        onOpenChange={(open) => {
          if (!open) setMovingFile(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('files.move')}</DialogTitle>
            <DialogDescription>
              {movingFile
                ? t('files.move.hint', { name: movingFile.filename })
                : null}
            </DialogDescription>
          </DialogHeader>
          <div
            className="files-move-tree"
            role="radiogroup"
            aria-label={t('files.move')}
          >
            <label className="files-move-tree-item">
              <input
                type="radio"
                name="move-folder"
                checked={moveTargetId === '__root__'}
                onChange={() => setMoveTargetId('__root__')}
              />
              <span>{t('files.folders.root')}</span>
            </label>
            {folderTree.map((node) => (
              <label
                key={node.id}
                className="files-move-tree-item"
                style={{ paddingLeft: `${12 + node.depth * 16}px` }}
              >
                <input
                  type="radio"
                  name="move-folder"
                  checked={moveTargetId === node.id}
                  onChange={() => setMoveTargetId(node.id)}
                />
                <Folder className="size-3.5 shrink-0 opacity-70" aria-hidden />
                <span>{node.name}</span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setMovingFile(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={busy || !movingFile}
              onClick={() => {
                if (movingFile) void moveFile(movingFile.id, moveTargetId)
              }}
            >
              {t('files.move.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名文件 */}
      <Dialog
        open={renamingFile != null}
        onOpenChange={(open) => {
          if (!open) setRenamingFile(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('files.rename')}</DialogTitle>
            <DialogDescription>{t('files.rename.hint')}</DialogDescription>
          </DialogHeader>
          <Input
            value={renameFileValue}
            autoFocus
            onChange={(e) => setRenameFileValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRenameFile()
            }}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRenamingFile(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={busy || !renameFileValue.trim()}
              onClick={() => void commitRenameFile()}
            >
              {t('files.rename.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 管理单个文件的标签；保持弹窗打开以便连续勾选。 */}
      <Dialog
        open={taggingFile != null}
        onOpenChange={(open) => {
          if (!open) {
            setTaggingFile(null)
            setNewManagedTag('')
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('files.tags.manageFile')}</DialogTitle>
            <DialogDescription>
              {taggingFile
                ? t('files.tags.manageFileHint', { name: taggingFile.filename })
                : null}
            </DialogDescription>
          </DialogHeader>
          <div className="files-sidebar-form files-tags-create">
            <Input
              value={newManagedTag}
              maxLength={64}
              placeholder={t('files.newTag')}
              onChange={(e) => setNewManagedTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void createAndAssignTag()
                }
              }}
            />
            <Button
              type="button"
              size="sm"
              disabled={busy || !newManagedTag.trim()}
              onClick={() => void createAndAssignTag()}
            >
              {findTagByName(tags, newManagedTag)
                ? t('files.tags.useExisting')
                : t('files.tags.create')}
            </Button>
          </div>
          <div className="files-row-tags files-tags-pick">
            {tags.length === 0 ? (
              <span className="text-muted-foreground">
                {t('files.tags.empty')}
              </span>
            ) : (
              tags.map((tag) => {
                const selected = (taggingFile?.tag_ids ?? []).includes(tag.id)
                return (
                  <button
                    key={tag.id}
                    type="button"
                    className={cn('files-tag', selected && 'files-tag--active')}
                    aria-pressed={selected}
                    disabled={busy || !taggingFile}
                    onClick={() => {
                      if (taggingFile) {
                        void toggleTagForFile(taggingFile, tag.id)
                      }
                    }}
                  >
                    {tag.name}
                  </button>
                )
              })
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => setTaggingFile(null)}
            >
              {t('common.ok')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除文件确认 */}
      <Dialog
        open={deletingFile != null}
        onOpenChange={(open) => {
          if (!open) setDeletingFile(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('files.deleteConfirm.title')}</DialogTitle>
            <DialogDescription>
              {deletingFile
                ? t('files.deleteConfirm.body', { name: deletingFile.filename })
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeletingFile(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || !deletingFile}
              onClick={() => void confirmDeleteFile()}
            >
              {t('files.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
