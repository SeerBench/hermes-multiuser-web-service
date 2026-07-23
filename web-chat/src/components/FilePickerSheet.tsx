import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { isWorkspaceFilePreviewable } from '../attachmentPreview'
import { filesPaginationItems } from '../filesListHelpers'
import {
  filterFilePickerFiles,
  filePickerPageSize,
  resolveFilePickerTagFilter,
  sliceFilePickerPage,
  sortFilePickerFiles,
  type FilePickerSortKey,
  type FilePickerSortOrder,
} from '../filePickerHelpers'
import { formatBytes } from '../format'
import { useT } from '../i18n'
import { subscribeViewport } from '../lib/breakpoints'
import {
  PlatformApiError,
  platform,
  type FileTag,
  type PlatformFile,
} from '../platformClient'
import {
  FilePreviewDrawer,
  type PreviewableFile,
} from './FilePreviewDrawer'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { cn } from '@/lib/utils'

function statusLabelKey(status: string): string {
  return `files.status.${status}`
}

export function FilePickerSheet({
  open,
  onOpenChange,
  workspaceId,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  onConfirm: (files: {
    name: string
    path: string
    size: number
    fileId: string
    mimeType?: string
  }[]) => void
}) {
  const t = useT()
  const [files, setFiles] = useState<PlatformFile[]>([])
  const [tags, setTags] = useState<FileTag[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [tagId, setTagId] = useState('')
  const [sort, setSort] = useState<FilePickerSortKey>('created_at')
  const [order, setOrder] = useState<FilePickerSortOrder>('desc')
  const [preview, setPreview] = useState<PreviewableFile | null>(null)
  const [mobile, setMobile] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(max-width: 767px)').matches
      : false,
  )

  useEffect(() => subscribeViewport(setMobile), [])

  const previewOpen = Boolean(preview)

  const filtered = useMemo(() => {
    const tagged = resolveFilePickerTagFilter(tagId, tags)
    const matched = filterFilePickerFiles(files, {
      query,
      tagId: tagged,
    })
    return sortFilePickerFiles(matched, sort, order)
  }, [files, query, tagId, tags, sort, order])

  const pageSize = filePickerPageSize(mobile)
  const { pageItems, safePage, totalPages } = useMemo(
    () => sliceFilePickerPage(filtered, page, pageSize),
    [filtered, page, pageSize],
  )
  const pageNumbers = useMemo(
    () => filesPaginationItems(safePage, totalPages),
    [safePage, totalPages],
  )

  const reload = useCallback(async () => {
    try {
      setError(null)
      const [fileRows, tagRows] = await Promise.all([
        platform.listFiles(workspaceId),
        platform.listFileTags(workspaceId),
      ])
      setFiles(fileRows)
      setTags(tagRows)
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [workspaceId])

  useEffect(() => {
    if (open) {
      setSelected(new Set())
      setPage(1)
      setQuery('')
      setTagId('')
      setPreview(null)
      void reload()
    }
  }, [open, reload])

  useEffect(() => {
    setPage(1)
  }, [query, tagId, sort, order])

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages))
  }, [totalPages])

  // Escape closes preview first (picker stays open)
  useEffect(() => {
    if (!previewOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        setPreview(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [previewOpen])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const openPreview = (f: PlatformFile) => {
    if (!isWorkspaceFilePreviewable(f.filename)) return
    setPreview({ fileId: f.id, name: f.filename })
  }

  const confirm = () => {
    const picked = files
      .filter((f) => selected.has(f.id))
      .map((f) => ({
        name: f.filename,
        path: f.storage_key ?? `uploads/${f.filename}`,
        size: f.size_bytes ?? 0,
        fileId: f.id,
        mimeType: f.mime_type,
      }))
    onConfirm(picked)
  }

  const handleDialogOpenChange = (next: boolean) => {
    if (!next && previewOpen) {
      setPreview(null)
      return
    }
    onOpenChange(next)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent
          className={cn(
            'file-picker-dialog',
            'flex max-h-[min(90vh,720px)] w-full max-w-[calc(100%-1.5rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg',
          )}
          onPointerDownOutside={(e) => {
            if (previewOpen) e.preventDefault()
          }}
          onInteractOutside={(e) => {
            if (previewOpen) e.preventDefault()
          }}
        >
          <DialogHeader className="file-picker-dialog-header shrink-0 border-b border-border px-6 py-4 text-left">
            <DialogTitle>{t('composer.filePicker.title')}</DialogTitle>
          </DialogHeader>

          <div className="file-picker-toolbar shrink-0 border-b border-border px-4 py-3">
            <div className="file-picker-search">
              <Search
                className="file-picker-search-icon size-4"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('files.search.placeholder')}
                className="file-picker-search-input h-9 pl-8"
                aria-label={t('files.search.placeholder')}
              />
            </div>
            <div className="file-picker-filters">
              <label className="file-picker-filter-field">
                <span>{t('files.tags.filter')}</span>
                <select
                  value={tagId}
                  onChange={(e) => setTagId(e.target.value)}
                >
                  <option value="">{t('files.tags.filterAll')}</option>
                  {tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="file-picker-filter-field">
                <span>{t('files.sort')}</span>
                <select
                  value={`${sort}:${order}`}
                  onChange={(e) => {
                    const [s, o] = e.target.value.split(':') as [
                      FilePickerSortKey,
                      FilePickerSortOrder,
                    ]
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
            </div>
          </div>

          <div className="file-picker-body min-h-0 flex-1 overflow-y-auto px-6 py-3">
            {error && <p className="auth-error">{error}</p>}
            {files.length === 0 && !error && (
              <p className="page-hint">{t('composer.filePicker.empty')}</p>
            )}
            {files.length > 0 && filtered.length === 0 && (
              <p className="page-hint">{t('composer.filePicker.noMatch')}</p>
            )}
            <div
              className="file-picker-list"
              role="list"
              aria-label={t('composer.filePicker.title')}
            >
              {pageItems.map((f) => {
                const previewable = isWorkspaceFilePreviewable(f.filename)
                return (
                  <div key={f.id} className="file-picker-row" role="listitem">
                    <Checkbox
                      checked={selected.has(f.id)}
                      onCheckedChange={() => toggle(f.id)}
                      aria-label={f.filename}
                    />
                    {previewable ? (
                      <button
                        type="button"
                        className="file-picker-name file-picker-name--link"
                        onClick={() => openPreview(f)}
                      >
                        {f.filename}
                      </button>
                    ) : (
                      <span className="file-picker-name">{f.filename}</span>
                    )}
                    <small className="file-picker-size">
                      {formatBytes(f.size_bytes ?? 0)}
                    </small>
                    <small
                      className={cn(
                        'file-picker-status',
                        `file-picker-status--${f.status}`,
                      )}
                      title={
                        f.status === 'ready'
                          ? t('files.status.ready.tip')
                          : f.status === 'skipped'
                            ? t('files.status.skipped.tip')
                            : (f.error_message ?? undefined)
                      }
                    >
                      {t(statusLabelKey(f.status) as 'files.status.ready')}
                    </small>
                  </div>
                )
              })}
            </div>
          </div>

          {totalPages > 1 && (
            <div className="file-picker-pagination shrink-0 border-t border-border px-3 py-2">
              <Pagination>
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      disabled={safePage <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      {t('files.pagination.prev')}
                    </PaginationPrevious>
                  </PaginationItem>
                  {pageNumbers.map((item, idx) =>
                    item < 0 ? (
                      <PaginationItem key={`e-${idx}`}>
                        <PaginationEllipsis />
                      </PaginationItem>
                    ) : (
                      <PaginationItem key={item}>
                        <PaginationLink
                          isActive={item === safePage}
                          onClick={() => setPage(item)}
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
                        setPage((p) => Math.min(totalPages, p + 1))
                      }
                    >
                      {t('files.pagination.next')}
                    </PaginationNext>
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          )}

          <DialogFooter className="file-picker-dialog-footer shrink-0 border-t border-border px-6 py-4 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={selected.size === 0}
              onClick={confirm}
            >
              {t('composer.filePicker.attach', { count: selected.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FilePreviewDrawer
        elevated
        open={previewOpen}
        onOpenChange={(next) => {
          if (!next) setPreview(null)
        }}
        workspaceId={workspaceId}
        file={preview}
      />
    </>
  )
}
