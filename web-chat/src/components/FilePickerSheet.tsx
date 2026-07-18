import { useCallback, useEffect, useMemo, useState } from 'react'
import { filesPaginationItems } from '../filesListHelpers'
import {
  filePickerPageSize,
  sliceFilePickerPage,
} from '../filePickerHelpers'
import { formatBytes } from '../format'
import { useT } from '../i18n'
import { subscribeViewport } from '../lib/breakpoints'
import {
  PlatformApiError,
  platform,
  type PlatformFile,
} from '../platformClient'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [mobile, setMobile] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(max-width: 767px)').matches
      : false,
  )

  useEffect(() => subscribeViewport(setMobile), [])

  const pageSize = filePickerPageSize(mobile)
  const { pageItems, safePage, totalPages } = useMemo(
    () => sliceFilePickerPage(files, page, pageSize),
    [files, page, pageSize],
  )
  const pageNumbers = useMemo(
    () => filesPaginationItems(safePage, totalPages),
    [safePage, totalPages],
  )

  const reload = useCallback(async () => {
    try {
      setError(null)
      setFiles(await platform.listFiles(workspaceId))
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [workspaceId])

  useEffect(() => {
    if (open) {
      setSelected(new Set())
      setPage(1)
      void reload()
    }
  }, [open, reload])

  // 切换桌面/移动 pageSize 时夹紧页码
  useEffect(() => {
    setPage((p) => Math.min(p, totalPages))
  }, [totalPages])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'file-picker-dialog',
          'flex max-h-[min(90vh,720px)] w-full max-w-[calc(100%-1.5rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg',
        )}
      >
        <DialogHeader className="file-picker-dialog-header shrink-0 border-b border-border px-6 py-4 text-left">
          <DialogTitle>{t('composer.filePicker.title')}</DialogTitle>
        </DialogHeader>

        <div className="file-picker-body min-h-0 flex-1 overflow-y-auto px-6 py-3">
          {error && <p className="auth-error">{error}</p>}
          {files.length === 0 && !error && (
            <p className="page-hint">{t('composer.filePicker.empty')}</p>
          )}
          <div
            className="file-picker-list"
            role="list"
            aria-label={t('composer.filePicker.title')}
          >
            {pageItems.map((f) => (
              <label key={f.id} className="file-picker-row" role="listitem">
                <Checkbox
                  checked={selected.has(f.id)}
                  onCheckedChange={() => toggle(f.id)}
                />
                <span className="file-picker-name">{f.filename}</span>
                <small className="file-picker-size">
                  {formatBytes(f.size_bytes ?? 0)}
                </small>
              </label>
            ))}
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
  )
}
