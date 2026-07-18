import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { PageShell } from '../components/PageShell'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { useLocale, useT } from '../i18n'
import { skillDisplayDescription } from '../skillDescriptions.zh'
import {
  PlatformApiError,
  getStoredWorkspaceId,
  platform,
  type SkillDetail,
  type SkillRow,
} from '../platformClient'
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
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

type SkillsTab = 'mine' | 'catalog'

function formatWhen(iso?: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export function SkillsPage() {
  const t = useT()
  const { locale } = useLocale()
  const workspaceId = getStoredWorkspaceId()
  const [skills, setSkills] = useState<SkillRow[]>([])
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<SkillDetail | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [advancedMd, setAdvancedMd] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createWorkflow, setCreateWorkflow] = useState('')
  const [createInputs, setCreateInputs] = useState('')
  const [createOutputs, setCreateOutputs] = useState('')
  const [createType, setCreateType] = useState('assistant')
  const [createContent, setCreateContent] = useState('')
  const [tab, setTab] = useState<SkillsTab>('mine')
  const [configOpen, setConfigOpen] = useState(false)
  const [configSkill, setConfigSkill] = useState<SkillRow | null>(null)
  const [configText, setConfigText] = useState('{}')

  const reload = useCallback(async () => {
    if (!workspaceId) return
    try {
      setSkills(await platform.listSkills(workspaceId))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [workspaceId])

  useEffect(() => {
    void reload()
  }, [reload])

  const describe = (skill: { name: string; description?: string | null }) =>
    skillDisplayDescription(locale, skill.name, skill.description)

  const stats = useMemo(() => {
    const mine = skills.filter((s) => s.source === 'user' || s.source === 'entitlement')
    const enabled = skills.filter((s) => s.enabled !== false).length
    return { total: skills.length, mine: mine.length, enabled }
  }, [skills])

  const setEnabled = async (name: string, next: boolean) => {
    if (!workspaceId) return
    setBusy(true)
    try {
      if (next) await platform.enableSkill(workspaceId, name)
      else await platform.disableSkill(workspaceId, name)
      await reload()
      toast.success(next ? t('skills.toast.enabled') : t('skills.toast.disabled'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const openDetail = async (name: string) => {
    if (!workspaceId) return
    setDetailBusy(true)
    setDetailOpen(true)
    setEditing(false)
    try {
      const detail = await platform.getSkill(workspaceId, name)
      setSelected(detail)
      setEditContent(detail.content)
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
      setDetailOpen(false)
    } finally {
      setDetailBusy(false)
    }
  }

  const saveEdit = async () => {
    if (!workspaceId || !selected) return
    setBusy(true)
    try {
      await platform.replaceSkill(workspaceId, selected.name, editContent)
      await reload()
      const detail = await platform.getSkill(workspaceId, selected.name)
      setSelected(detail)
      setEditing(false)
      toast.success(t('skills.toast.saved'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const removeSkill = async (name: string) => {
    if (!workspaceId) return
    if (!window.confirm(t('skills.deleteConfirm', { name }))) return
    setBusy(true)
    try {
      await platform.deleteSkill(workspaceId, name)
      setDetailOpen(false)
      setSelected(null)
      await reload()
      toast.success(t('skills.toast.deleted'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const resetCreateForm = () => {
    setCreateName('')
    setCreateDesc('')
    setCreateWorkflow('')
    setCreateInputs('')
    setCreateOutputs('')
    setCreateType('assistant')
    setCreateContent('')
    setAdvancedMd(false)
  }

  const createSkill = async () => {
    if (!workspaceId || !createName.trim()) return
    setBusy(true)
    try {
      if (advancedMd) {
        await platform.createSkill(workspaceId, {
          name: createName.trim(),
          skill_md: createContent,
        })
      } else {
        if (!createDesc.trim()) {
          toast.error(t('skills.create.needDesc'))
          setBusy(false)
          return
        }
        await platform.createSkill(workspaceId, {
          name: createName.trim(),
          description: createDesc.trim(),
          workflow: createWorkflow.trim() || undefined,
          inputs: createInputs.trim() || undefined,
          outputs: createOutputs.trim() || undefined,
          type: createType,
          version: '1.0',
        })
      }
      await reload()
      setCreateOpen(false)
      resetCreateForm()
      setTab('mine')
      toast.success(t('skills.toast.created'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const installFromCatalog = async (name: string) => {
    if (!workspaceId) return
    setBusy(true)
    try {
      await platform.installSkillFromCatalog(workspaceId, name)
      await reload()
      setSelected(await platform.getSkill(workspaceId, name))
      setDetailOpen(true)
      setTab('mine')
      toast.success(t('skills.toast.installed'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const openConfig = (skill: SkillRow) => {
    setConfigSkill(skill)
    setConfigText(JSON.stringify(skill.config ?? {}, null, 2))
    setConfigOpen(true)
  }

  const saveConfig = async () => {
    if (!workspaceId || !configSkill) return
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(configText || '{}') as Record<string, unknown>
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('config must be a JSON object')
      }
    } catch {
      toast.error(t('skills.config.invalid'))
      return
    }
    setBusy(true)
    try {
      await platform.patchSkill(workspaceId, configSkill.name, { config: parsed })
      await reload()
      setConfigOpen(false)
      toast.success(t('skills.config.saved'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!workspaceId) {
    return (
      <p className="text-muted-foreground p-4 text-sm">{t('skills.noWorkspace')}</p>
    )
  }

  const globalSkills = skills.filter((s) => s.source === 'global')
  const userSkills = skills.filter((s) => s.source === 'user')
  const otherSkills = skills.filter(
    (s) => s.source !== 'global' && s.source !== 'user',
  )
  const mySkills = [...userSkills, ...otherSkills]

  return (
    <PageShell
      title={t('nav.skills')}
      hint={t('skills.hint')}
      density="reading"
      constrainWidth={false}
      actions={
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          {t('skills.create')}
        </Button>
      }
    >
      <div className="skill-stats" aria-live="polite">
        <span>
          {t('skills.stats.total')}: <strong>{stats.total}</strong>
        </span>
        <span>
          {t('skills.stats.mine')}: <strong>{stats.mine}</strong>
        </span>
        <span>
          {t('skills.stats.enabled')}: <strong>{stats.enabled}</strong>
        </span>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as SkillsTab)}
        className="skills-tabs gap-4"
      >
        <TabsList className="bg-muted/80">
          <TabsTrigger value="mine">{t('skills.tab.mine')}</TabsTrigger>
          <TabsTrigger value="catalog">{t('skills.tab.catalog')}</TabsTrigger>
        </TabsList>

        <TabsContent value="mine" className="space-y-2 outline-none">
          {mySkills.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('skills.mine.empty')}</p>
          ) : (
            mySkills.map((s) => (
              <SkillListItem
                key={`${s.source}-${s.name}`}
                skill={s}
                description={describe(s)}
                busy={busy || detailBusy}
                onSelect={() => void openDetail(s.name)}
                onEnable={() => void setEnabled(s.name, true)}
                onDisable={() => void setEnabled(s.name, false)}
                onConfig={() => openConfig(s)}
                enableLabel={t('skills.action.enable')}
                disableLabel={t('skills.action.disable')}
                configLabel={t('skills.action.config')}
                onDelete={
                  s.source === 'user'
                    ? () => void removeSkill(s.name)
                    : undefined
                }
                deleteLabel={t('skills.delete')}
                statusLabel={t('skills.field.status')}
                versionLabel={t('skills.field.version')}
                updatedLabel={t('skills.field.updated')}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="catalog" className="space-y-2 outline-none">
          <p className="text-muted-foreground mb-2 text-sm">
            {t('skills.catalog.hint')}
          </p>
          {globalSkills.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t('skills.catalog.empty')}
            </p>
          ) : (
            globalSkills.map((s) => (
              <SkillListItem
                key={s.name}
                skill={s}
                description={describe(s)}
                busy={busy || detailBusy}
                onSelect={() => void openDetail(s.name)}
                onEnable={() => void setEnabled(s.name, true)}
                onDisable={() => void setEnabled(s.name, false)}
                onConfig={() => openConfig(s)}
                enableLabel={t('skills.action.enable')}
                disableLabel={t('skills.action.disable')}
                configLabel={t('skills.action.config')}
                onInstall={() => void installFromCatalog(s.name)}
                installLabel={t('skills.install')}
                statusLabel={t('skills.field.status')}
                versionLabel={t('skills.field.version')}
                updatedLabel={t('skills.field.updated')}
              />
            ))
          )}
        </TabsContent>
      </Tabs>

      <Dialog
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open)
          if (!open) setSelected(null)
        }}
      >
        <DialogContent className="flex h-[min(90vh,900px)] w-full max-w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[800px]">
          <DialogHeader className="shrink-0 border-b border-border px-6 py-4 text-left">
            <DialogTitle>{selected?.name ?? t('nav.skills')}</DialogTitle>
            <DialogDescription>
              {detailBusy
                ? t('common.loading')
                : selected
                  ? `${t('skills.detail.source')}: ${selected.source}${
                      selected.category ? ` · ${selected.category}` : ''
                    }${selected.version ? ` · v${selected.version}` : ''}`
                  : t('skills.detail.empty')}
            </DialogDescription>
          </DialogHeader>
          {selected && !detailBusy && (
            <>
              <div className="overlay-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-4">
                <div className="skill-detail-meta mb-3 text-xs text-muted-foreground">
                  <span>
                    {t('skills.field.status')}: {selected.status ?? '—'}
                  </span>
                  <span>
                    {t('skills.field.type')}: {selected.type ?? '—'}
                  </span>
                  <span>
                    {t('skills.field.updated')}:{' '}
                    {formatWhen(selected.updated_at)}
                  </span>
                </div>
                {!editing && describe(selected) && (
                  <p className="text-muted-foreground mb-3 text-sm">
                    {describe(selected)}
                  </p>
                )}
                {selected.source === 'user' && !editing && (
                  <p className="text-muted-foreground mb-3 text-xs">
                    {t('skills.detail.userHint')}
                  </p>
                )}
                {editing && selected.source === 'user' ? (
                  <MarkdownEditor
                    value={editContent}
                    onChange={setEditContent}
                    minHeight={360}
                  />
                ) : (
                  <pre className="skills-detail-content skills-detail-content--dialog">
                    {selected.content}
                  </pre>
                )}
              </div>
              <DialogFooter className="shrink-0 gap-2 border-t border-border px-6 py-3">
                {selected.source === 'user' && (
                  <>
                    {editing ? (
                      <Button
                        type="button"
                        disabled={busy}
                        onClick={() => void saveEdit()}
                      >
                        {t('skills.save')}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setEditing(true)}
                      >
                        {t('skills.edit')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void removeSkill(selected.name)}
                    >
                      {t('skills.delete')}
                    </Button>
                  </>
                )}
                {selected.source === 'global' && (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void installFromCatalog(selected.name)}
                  >
                    {busy ? t('skills.installing') : t('skills.install')}
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) resetCreateForm()
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('skills.create')}</DialogTitle>
            <DialogDescription>{t('skills.createHint')}</DialogDescription>
          </DialogHeader>
          <label className="skill-field">
            <span>{t('skills.createName')}</span>
            <Input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder={t('skills.createName.placeholder')}
            />
          </label>
          {!advancedMd ? (
            <>
              <label className="skill-field">
                <span>{t('skills.create.desc')}</span>
                <textarea
                  className="skill-textarea"
                  rows={2}
                  value={createDesc}
                  onChange={(e) => setCreateDesc(e.target.value)}
                  aria-label={t('skills.create.desc')}
                />
              </label>
              <label className="skill-field">
                <span>{t('skills.create.workflow')}</span>
                <textarea
                  className="skill-textarea"
                  rows={4}
                  value={createWorkflow}
                  onChange={(e) => setCreateWorkflow(e.target.value)}
                  placeholder={t('skills.create.workflow.placeholder')}
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="skill-field">
                  <span>{t('skills.create.inputs')}</span>
                  <Input
                    value={createInputs}
                    onChange={(e) => setCreateInputs(e.target.value)}
                  />
                </label>
                <label className="skill-field">
                  <span>{t('skills.create.outputs')}</span>
                  <Input
                    value={createOutputs}
                    onChange={(e) => setCreateOutputs(e.target.value)}
                  />
                </label>
              </div>
              <label className="skill-field">
                <span>{t('skills.field.type')}</span>
                <select
                  className="skill-select"
                  value={createType}
                  onChange={(e) => setCreateType(e.target.value)}
                >
                  <option value="assistant">assistant</option>
                  <option value="analysis">analysis</option>
                  <option value="workflow">workflow</option>
                  <option value="tool">tool</option>
                </select>
              </label>
            </>
          ) : (
            <MarkdownEditor
              value={createContent}
              onChange={setCreateContent}
              minHeight={280}
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setAdvancedMd((v) => !v)}
          >
            {advancedMd
              ? t('skills.create.structured')
              : t('skills.create.advanced')}
          </Button>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={busy || !createName.trim()}
              onClick={() => void createSkill()}
            >
              {t('skills.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t('skills.config.title')}
              {configSkill ? ` — ${configSkill.name}` : ''}
            </DialogTitle>
            <DialogDescription>{t('skills.config.hint')}</DialogDescription>
          </DialogHeader>
          <textarea
            className="skill-textarea font-mono"
            rows={10}
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            aria-label={t('skills.config.title')}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfigOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void saveConfig()}
            >
              {t('skills.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}

type ItemProps = {
  skill: SkillRow
  description: string
  busy: boolean
  onSelect: () => void
  onEnable: () => void
  onDisable: () => void
  onConfig: () => void
  enableLabel: string
  disableLabel: string
  configLabel: string
  onInstall?: () => void
  installLabel?: string
  onDelete?: () => void
  deleteLabel?: string
  statusLabel: string
  versionLabel: string
  updatedLabel: string
}

function SkillListItem({
  skill,
  description,
  busy,
  onSelect,
  onEnable,
  onDisable,
  onConfig,
  enableLabel,
  disableLabel,
  configLabel,
  onInstall,
  installLabel,
  onDelete,
  deleteLabel,
  statusLabel,
  versionLabel,
  updatedLabel,
}: ItemProps) {
  const enabled = skill.enabled !== false
  return (
    <div
      className={cn(
        'skill-item flex flex-col gap-3 rounded-lg border border-border p-3',
      )}
    >
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={onSelect}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{skill.name}</span>
          <Badge variant="outline" className="text-[10px] uppercase">
            {skill.source}
          </Badge>
          <Badge variant={enabled ? 'secondary' : 'outline'}>
            {skill.status ?? (enabled ? 'enabled' : 'disabled')}
          </Badge>
          {skill.version ? (
            <span className="text-muted-foreground text-xs">
              {versionLabel}: {skill.version}
            </span>
          ) : null}
        </div>
        {description && (
          <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
            {description}
          </p>
        )}
        <p className="text-muted-foreground mt-1 text-[11px]">
          {statusLabel}: {skill.status ?? '—'} · {updatedLabel}:{' '}
          {formatWhen(skill.updated_at)}
        </p>
      </button>
      <div className="flex flex-wrap shrink-0 items-center gap-2">
        {enabled ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onDisable}
          >
            {disableLabel}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={onEnable}
          >
            {enableLabel}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={onConfig}
        >
          {configLabel}
        </Button>
        {onInstall && installLabel && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onInstall}
          >
            {installLabel}
          </Button>
        )}
        {onDelete && deleteLabel && (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={onDelete}
          >
            {deleteLabel}
          </Button>
        )}
      </div>
    </div>
  )
}
