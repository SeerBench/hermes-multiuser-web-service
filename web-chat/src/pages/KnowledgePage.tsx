import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { PageShell } from '../components/PageShell'
import { useT } from '../i18n'
import {
  PlatformApiError,
  getStoredWorkspaceId,
  platform,
  type KnowledgeBase,
  type KnowledgeSearchHit,
  type KnowledgeStats,
  type PlatformFile,
} from '../platformClient'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

type CenterTab = 'mine' | 'create'

const CATEGORIES = ['trading', 'tech', 'learning', 'other'] as const

function formatWhen(iso?: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export function KnowledgePage() {
  const t = useT()
  const workspaceId = getStoredWorkspaceId()
  const [tab, setTab] = useState<CenterTab>('mine')
  const [items, setItems] = useState<KnowledgeBase[]>([])
  const [stats, setStats] = useState<KnowledgeStats | null>(null)
  const [files, setFiles] = useState<PlatformFile[]>([])
  const [busy, setBusy] = useState(false)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<string>('other')
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())

  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<KnowledgeBase | null>(null)
  const [searchQ, setSearchQ] = useState('')
  const [searchHits, setSearchHits] = useState<KnowledgeSearchHit[]>([])

  const reload = useCallback(async () => {
    if (!workspaceId) return
    try {
      const [listRes, statsRes] = await Promise.all([
        platform.listKnowledgeBases(workspaceId),
        platform.getKnowledgeStats(workspaceId),
      ])
      setItems(listRes.items)
      setStats(statsRes)
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [workspaceId])

  const loadFiles = useCallback(async () => {
    if (!workspaceId) return
    try {
      setFiles(await platform.listFiles(workspaceId))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [workspaceId])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (tab === 'create') void loadFiles()
  }, [tab, loadFiles])

  const toggleFile = (id: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const createKb = async () => {
    if (!workspaceId) return
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error(t('knowledge.error.name'))
      return
    }
    if (selectedFiles.size === 0) {
      toast.error(t('knowledge.error.files'))
      return
    }
    setBusy(true)
    try {
      await platform.createKnowledgeBase(workspaceId, {
        name: trimmed,
        description: description.trim(),
        category,
        file_ids: [...selectedFiles],
      })
      toast.success(t('knowledge.toast.created'))
      setName('')
      setDescription('')
      setCategory('other')
      setSelectedFiles(new Set())
      setTab('mine')
      await reload()
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const openDetail = async (id: string) => {
    if (!workspaceId) return
    setBusy(true)
    setSearchHits([])
    setSearchQ('')
    try {
      const row = await platform.getKnowledgeBase(workspaceId, id)
      setDetail(row)
      setDetailOpen(true)
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const removeKb = async (id: string) => {
    if (!workspaceId) return
    if (!window.confirm(t('knowledge.deleteConfirm'))) return
    setBusy(true)
    try {
      await platform.deleteKnowledgeBase(workspaceId, id)
      toast.success(t('knowledge.toast.deleted'))
      setDetailOpen(false)
      setDetail(null)
      await reload()
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const reindexKb = async (id: string) => {
    if (!workspaceId) return
    setBusy(true)
    try {
      const row = await platform.reindexKnowledgeBase(workspaceId, id)
      setDetail(row)
      toast.success(t('knowledge.toast.reindexed'))
      await reload()
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const runSearch = async () => {
    if (!workspaceId || !detail) return
    const q = searchQ.trim()
    if (!q) return
    setBusy(true)
    try {
      const res = await platform.searchKnowledgeBases(workspaceId, q, {
        knowledge_id: detail.id,
        top_k: 5,
      })
      setSearchHits(res.results)
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const statsLine = useMemo(() => {
    if (!stats) return null
    return (
      <div className="memory-stats">
        <span>
          {t('knowledge.stats.bases')}: <strong>{stats.knowledge_count}</strong>
        </span>
        <span>
          {t('knowledge.stats.docs')}: <strong>{stats.document_count}</strong>
        </span>
        <span>
          {t('knowledge.stats.chunks')}: <strong>{stats.chunk_count}</strong>
        </span>
        <span>
          {t('knowledge.stats.updated')}:{' '}
          <strong>{formatWhen(stats.last_updated_at)}</strong>
        </span>
      </div>
    )
  }, [stats, t])

  const statusBadge = (status: string) => {
    const variant =
      status === 'ready'
        ? 'default'
        : status === 'failed'
          ? 'destructive'
          : 'secondary'
    const labelKey = `knowledge.status.${status}`
    return <Badge variant={variant}>{t(labelKey)}</Badge>
  }

  if (!workspaceId) {
    return <p className="page-hint">{t('knowledge.noWorkspace')}</p>
  }

  return (
    <PageShell
      title={t('nav.knowledge')}
      hint={t('knowledge.intro')}
      density="reading"
      constrainWidth={false}
      actions={
        <Button
          type="button"
          onClick={() => setTab('create')}
          disabled={busy}
        >
          {t('knowledge.create')}
        </Button>
      }
    >
      {statsLine}

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as CenterTab)}
        className="memory-center-tabs"
      >
        <TabsList variant="line" className="flex flex-wrap h-auto">
          <TabsTrigger value="mine">{t('knowledge.tab.mine')}</TabsTrigger>
          <TabsTrigger value="create">{t('knowledge.tab.create')}</TabsTrigger>
        </TabsList>

        <TabsContent value="mine" className="memory-list">
          {items.length === 0 ? (
            <p className="page-hint">{t('knowledge.empty')}</p>
          ) : null}
          <ul className="memory-item-list">
            {items.map((row) => (
              <li
                key={row.id}
                className={cn('memory-item', 'knowledge-item')}
              >
                <div className="memory-item-main">
                  <div className="memory-item-title-row">
                    <strong>{row.name}</strong>
                    {statusBadge(row.status)}
                    <Badge variant="outline">{row.category}</Badge>
                  </div>
                  {row.description ? (
                    <p className="page-hint">{row.description}</p>
                  ) : null}
                  <p className="page-hint">
                    {t('knowledge.meta.files', { n: row.file_count })} ·{' '}
                    {t('knowledge.meta.chunks', { n: row.chunk_count })} ·{' '}
                    {formatWhen(row.updated_at)}
                  </p>
                  {row.error_message ? (
                    <p className="page-hint text-destructive">
                      {row.error_message}
                    </p>
                  ) : null}
                </div>
                <div className="memory-item-actions">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void openDetail(row.id)}
                  >
                    {t('knowledge.action.detail')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void removeKb(row.id)}
                  >
                    {t('knowledge.action.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </TabsContent>

        <TabsContent value="create" className="memory-list">
          <div className="knowledge-create-form space-y-3">
            <label className="block space-y-1">
              <span>{t('knowledge.field.name')}</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('knowledge.field.namePlaceholder')}
              />
            </label>
            <label className="block space-y-1">
              <span>{t('knowledge.field.description')}</span>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span>{t('knowledge.field.category')}</span>
              <select
                className="memory-select"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`knowledge.category.${c}`)}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <p className="page-hint mb-2">{t('knowledge.field.pickFiles')}</p>
              {files.length === 0 ? (
                <p className="page-hint">{t('knowledge.noFiles')}</p>
              ) : (
                <ul className="memory-item-list">
                  {files.map((f) => (
                    <li key={f.id} className="memory-item">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedFiles.has(f.id)}
                          onChange={() => toggleFile(f.id)}
                        />
                        <span>{f.filename}</span>
                        <Badge variant="outline">{f.status}</Badge>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Button type="button" disabled={busy} onClick={() => void createKb()}>
              {t('knowledge.action.submit')}
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{detail?.name ?? t('nav.knowledge')}</DialogTitle>
          </DialogHeader>
          {detail ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 items-center">
                {statusBadge(detail.status)}
                <Badge variant="outline">{detail.category}</Badge>
              </div>
              {detail.description ? (
                <p className="page-hint">{detail.description}</p>
              ) : null}
              <p className="page-hint">
                {t('knowledge.meta.files', { n: detail.file_count })} ·{' '}
                {t('knowledge.meta.chunks', { n: detail.chunk_count })}
              </p>
              {detail.files && detail.files.length > 0 ? (
                <ul className="text-sm space-y-1">
                  {detail.files.map((f) => (
                    <li key={f.file_id}>
                      {f.filename}{' '}
                      <Badge variant="outline">{f.status ?? ''}</Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex gap-2">
                <Input
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  placeholder={t('knowledge.search.placeholder')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void runSearch()
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void runSearch()}
                >
                  {t('knowledge.search.run')}
                </Button>
              </div>
              {searchHits.length > 0 ? (
                <ul className="space-y-2 text-sm max-h-48 overflow-auto">
                  {searchHits.map((h) => (
                    <li key={h.chunk_id} className="border-b pb-2">
                      <Badge variant="secondary">{h.score}</Badge>{' '}
                      {h.filename ? <em>{h.filename}</em> : null}
                      <p>{h.content}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <DialogFooter className="gap-2">
            {detail ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void reindexKb(detail.id)}
                >
                  {t('knowledge.action.reindex')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void removeKb(detail.id)}
                >
                  {t('knowledge.action.delete')}
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDetailOpen(false)}
            >
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
