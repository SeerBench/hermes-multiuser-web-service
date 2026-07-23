import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { PageShell } from '../components/PageShell'
import { useT } from '../i18n'
import {
  PlatformApiError,
  getStoredWorkspaceId,
  platform,
  type MemoryItem,
  type MemoryStats,
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

type CenterTab = 'profile' | 'preference' | 'project' | 'pending' | 'all'

const CATEGORY_TABS: { id: CenterTab; category?: string; status?: string }[] = [
  { id: 'profile', category: 'profile', status: 'active' },
  { id: 'preference', category: 'preference', status: 'active' },
  { id: 'project', category: 'project', status: 'active' },
  { id: 'pending', status: 'pending' },
  { id: 'all' },
]

function formatWhen(iso?: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export function MemoryPage() {
  const t = useT()
  const workspaceId = getStoredWorkspaceId()
  const [tab, setTab] = useState<CenterTab>('profile')
  const [items, setItems] = useState<MemoryItem[]>([])
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [sort, setSort] = useState<'updated_at' | 'created_at' | 'importance'>(
    'updated_at',
  )
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<MemoryItem | null>(null)
  const [draftContent, setDraftContent] = useState('')
  const [draftCategory, setDraftCategory] = useState('preference')
  const [createOpen, setCreateOpen] = useState(false)

  const reload = useCallback(async () => {
    if (!workspaceId) return
    const tabDef = CATEGORY_TABS.find((x) => x.id === tab) ?? CATEGORY_TABS[0]
    try {
      const [listRes, statsRes] = await Promise.all([
        platform.listMemoryItems(workspaceId, {
          q: tab === 'all' ? q || undefined : undefined,
          category:
            tab === 'all'
              ? categoryFilter || undefined
              : tabDef.category,
          status: tabDef.status,
          sort: tab === 'all' ? sort : 'updated_at',
        }),
        platform.getMemoryStats(workspaceId),
      ])
      setItems(listRes.items)
      setStats(statsRes)
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [workspaceId, tab, q, categoryFilter, sort])

  useEffect(() => {
    if (!workspaceId) return
    // 首次进入：幂等导入历史 MEMORY.md / USER.md
    void platform
      .migrateMemoryFromFiles(workspaceId)
      .catch(() => undefined)
      .finally(() => {
        void reload()
      })
  }, [workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps -- migrate once per workspace

  useEffect(() => {
    void reload()
  }, [reload])

  const openCreate = () => {
    setEditing(null)
    setDraftContent('')
    setDraftCategory(
      tab === 'profile' || tab === 'preference' || tab === 'project'
        ? tab
        : 'preference',
    )
    setCreateOpen(true)
    setEditOpen(true)
  }

  const openEdit = (item: MemoryItem) => {
    setEditing(item)
    setDraftContent(item.content)
    setDraftCategory(item.category)
    setCreateOpen(false)
    setEditOpen(true)
  }

  const saveEdit = async () => {
    if (!workspaceId || !draftContent.trim()) return
    setBusy(true)
    try {
      if (editing) {
        await platform.updateMemoryItem(workspaceId, editing.id, {
          content: draftContent.trim(),
          category: draftCategory,
        })
        toast.success(t('memory.saved'))
      } else {
        await platform.createMemoryItem(workspaceId, {
          category: draftCategory,
          content: draftContent.trim(),
          status: 'active',
          source: 'manual',
        })
        toast.success(t('memory.created'))
      }
      setEditOpen(false)
      await reload()
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (item: MemoryItem) => {
    if (!workspaceId) return
    setBusy(true)
    try {
      await platform.deleteMemoryItem(workspaceId, item.id)
      toast.success(t('memory.deleted'))
      await reload()
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const approve = async (item: MemoryItem) => {
    if (!workspaceId) return
    setBusy(true)
    try {
      await platform.approveMemoryItem(workspaceId, item.id)
      toast.success(t('memory.approved'))
      await reload()
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const reject = async (item: MemoryItem) => {
    if (!workspaceId) return
    setBusy(true)
    try {
      await platform.rejectMemoryItem(workspaceId, item.id)
      toast.success(t('memory.rejected'))
      await reload()
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const statsLine = useMemo(() => {
    if (!stats) return null
    return (
      <div className="memory-stats" aria-live="polite">
        <span>
          {t('memory.stats.total')}: <strong>{stats.total}</strong>
        </span>
        <span>
          {t('memory.stats.pending')}: <strong>{stats.pending}</strong>
        </span>
        <span>
          {t('memory.stats.updated')}:{' '}
          <strong>{formatWhen(stats.last_updated_at)}</strong>
        </span>
      </div>
    )
  }, [stats, t])

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
        <Button type="button" onClick={openCreate} disabled={busy}>
          {t('memory.add')}
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
          <TabsTrigger value="profile">{t('memory.tab.profile')}</TabsTrigger>
          <TabsTrigger value="preference">
            {t('memory.tab.preferences')}
          </TabsTrigger>
          <TabsTrigger value="project">{t('memory.tab.projects')}</TabsTrigger>
          <TabsTrigger value="pending">
            {t('memory.tab.pending')}
            {stats && stats.pending > 0 ? (
              <Badge variant="secondary" className="ml-1">
                {stats.pending}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="all">{t('memory.tab.all')}</TabsTrigger>
        </TabsList>

        {tab === 'all' ? (
          <div className="memory-filters">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('memory.search')}
              aria-label={t('memory.search')}
            />
            <select
              className="memory-select"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              aria-label={t('memory.filter.category')}
            >
              <option value="">{t('memory.filter.allCategories')}</option>
              <option value="profile">Profile</option>
              <option value="preference">Preference</option>
              <option value="project">Project</option>
              <option value="knowledge">Knowledge</option>
              <option value="skill">Skill</option>
              <option value="workflow">Workflow</option>
            </select>
            <select
              className="memory-select"
              value={sort}
              onChange={(e) =>
                setSort(e.target.value as 'updated_at' | 'created_at' | 'importance')
              }
              aria-label={t('memory.sort')}
            >
              <option value="updated_at">{t('memory.sort.updated')}</option>
              <option value="created_at">{t('memory.sort.created')}</option>
              <option value="importance">{t('memory.sort.importance')}</option>
            </select>
          </div>
        ) : null}

        {CATEGORY_TABS.map((def) => (
          <TabsContent key={def.id} value={def.id} className="memory-list">
            {def.id === 'pending' && items.length === 0 ? (
              <p className="page-hint">{t('memory.pending.empty')}</p>
            ) : null}
            {def.id === 'pending' && items.length > 0 ? (
              <p className="page-hint">{t('memory.pending.intro')}</p>
            ) : null}
            {items.length === 0 && def.id !== 'pending' ? (
              <p className="page-hint">{t('memory.empty')}</p>
            ) : null}
            <ul className="memory-item-list">
              {items.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    'memory-item',
                    item.status === 'pending' && 'memory-item--pending',
                  )}
                >
                  <div className="memory-item-meta">
                    <Badge variant="outline">{item.category}</Badge>
                    <span className="memory-item-source">
                      {t('memory.field.source')}: {item.source}
                      {item.source_ref ? ` · ${item.source_ref}` : ''}
                    </span>
                    <span>
                      {t('memory.field.confidence')}:{' '}
                      {Math.round((item.confidence ?? 0) * 100)}%
                    </span>
                    <span>
                      {t('memory.field.updated')}: {formatWhen(item.updated_at)}
                    </span>
                  </div>
                  <p className="memory-item-content">{item.content}</p>
                  {item.raw_excerpt ? (
                    <p className="memory-item-excerpt">
                      {t('memory.field.raw')}: {item.raw_excerpt}
                    </p>
                  ) : null}
                  <div className="memory-item-actions">
                    {item.status === 'pending' ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          disabled={busy}
                          onClick={() => void approve(item)}
                        >
                          {t('memory.action.save')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => openEdit(item)}
                        >
                          {t('memory.action.edit')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void reject(item)}
                        >
                          {t('memory.action.ignore')}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => openEdit(item)}
                        >
                          {t('memory.action.edit')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void remove(item)}
                        >
                          {t('memory.action.delete')}
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </TabsContent>
        ))}
      </Tabs>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {createOpen ? t('memory.add') : t('memory.action.edit')}
            </DialogTitle>
          </DialogHeader>
          <label className="memory-field">
            <span>{t('memory.field.category')}</span>
            <select
              className="memory-select"
              value={draftCategory}
              onChange={(e) => setDraftCategory(e.target.value)}
            >
              <option value="profile">profile</option>
              <option value="preference">preference</option>
              <option value="project">project</option>
              <option value="knowledge">knowledge</option>
              <option value="skill">skill</option>
              <option value="workflow">workflow</option>
            </select>
          </label>
          <label className="memory-field">
            <span>{t('memory.field.content')}</span>
            <textarea
              className="memory-textarea"
              rows={5}
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              aria-label={t('memory.field.content')}
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={busy || !draftContent.trim()}
              onClick={() => void saveEdit()}
            >
              {t('memory.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
