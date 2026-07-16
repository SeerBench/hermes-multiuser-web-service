import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import {
  Brain,
  ChevronDown,
  FolderOpen,
  Layers,
  Paperclip,
  Plus,
  Search,
  Send,
  Square,
} from 'lucide-react'
import { PendingAttachments, type PendingAttachment } from './AttachmentChips'
import { SlashCommandPopover } from './SlashCommandPopover'
import type { CommandSpec } from '../api'
import { useT } from '../i18n'
import {
  modelBadges,
  modelBrand,
  modelDisplayName,
} from '../modelDisplay'
import { FilePickerSheet } from './FilePickerSheet'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { subscribeViewport } from '@/lib/breakpoints'

export type ModelOption = { id: string; owned_by?: string }

type ChatComposerProps = {
  input: string
  onInputChange: (v: string) => void
  onSubmit: (e?: FormEvent) => void
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  streaming: boolean
  uploading: boolean
  pending: PendingAttachment[]
  onRemovePending: (id: string) => void
  onPickFiles: (files: FileList | null) => void
  onAttachWorkspaceFiles: (paths: {
    name: string
    path: string
    size: number
    fileId?: string
    mimeType?: string
  }[]) => void
  onStop: () => void
  placeholder: string
  showSlashPopover: boolean
  slashQuery: string | null
  commandCatalog: CommandSpec[]
  onSlashSelect: (cmd: CommandSpec) => void
  onSlashClose: () => void
  platformMode?: boolean
  workspaceId?: string | null
  models: ModelOption[]
  selectedModel: string
  onModelChange: (model: string) => void
  modelsLoading?: boolean
  /** When true, `models` is already filtered to the user's favorites. */
  usingFavorites?: boolean
  onNavigate?: (route: 'memory' | 'skills' | 'files' | 'settings') => void
  enabledSkillsCount?: number
  /** Open md/pdf preview drawer for a library attachment. */
  onPreviewDoc?: (item: PendingAttachment) => void
}

type MenuItem = {
  key: string
  icon: ReactNode
  label: string
  action: () => void
}

function ModelBrandAvatar({ modelId }: { modelId: string }) {
  const brand = modelBrand(modelId)
  return (
    <span
      className="composer-model-avatar"
      style={{ backgroundColor: brand.color }}
      aria-hidden
    >
      {brand.mark}
    </span>
  )
}

export function ChatComposer({
  input,
  onInputChange,
  onSubmit,
  onKeyDown,
  streaming,
  uploading,
  pending,
  onRemovePending,
  onPickFiles,
  onAttachWorkspaceFiles,
  onStop,
  placeholder,
  showSlashPopover,
  slashQuery,
  commandCatalog,
  onSlashSelect,
  onSlashClose,
  platformMode,
  workspaceId,
  models,
  selectedModel,
  onModelChange,
  modelsLoading,
  usingFavorites = false,
  onNavigate,
  enabledSkillsCount = 0,
  onPreviewDoc,
}: ChatComposerProps) {
  const t = useT()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [modelFilter, setModelFilter] = useState('')
  const [mobile, setMobile] = useState(false)

  useEffect(() => subscribeViewport(setMobile), [])

  // 默认 2 行，随内容增高至最多 5 行，超出后出现滚动条
  const syncTextareaHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const cs = getComputedStyle(el)
    let lineHeight = parseFloat(cs.lineHeight)
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
      lineHeight = parseFloat(cs.fontSize) * 1.5 || 22
    }
    const padY =
      (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    const minH = lineHeight * 2 + padY
    const maxH = lineHeight * 5 + padY
    el.style.height = 'auto'
    const contentH = el.scrollHeight
    el.style.height = `${Math.min(Math.max(contentH, minH), maxH)}px`
    el.style.overflowY = contentH > maxH + 1 ? 'auto' : 'hidden'
  }, [])

  useEffect(() => {
    syncTextareaHeight()
  }, [input, syncTextareaHeight])

  useEffect(() => {
    if (modelOpen) {
      // 打开后聚焦搜索框，贴近截图交互
      const id = window.setTimeout(() => searchInputRef.current?.focus(), 0)
      return () => window.clearTimeout(id)
    }
    setModelFilter('')
  }, [modelOpen])

  const canSend =
    !streaming &&
    !uploading &&
    (input.trim().length > 0 ||
      pending.some((p) => p.status === 'done' && p.path))

  const filteredModels = models.filter((m) => {
    const q = modelFilter.trim().toLowerCase()
    if (!q) return true
    return (
      m.id.toLowerCase().includes(q) ||
      modelDisplayName(m.id).toLowerCase().includes(q) ||
      (m.owned_by?.toLowerCase().includes(q) ?? false)
    )
  })

  const selectedLabel = selectedModel
    ? modelDisplayName(selectedModel)
    : t('composer.model.pick')

  const closeMenu = useCallback(() => setMenuOpen(false), [])

  const menuItems: MenuItem[] = [
    {
      key: 'attach',
      icon: <Paperclip className="size-4" />,
      label: t('composer.menu.attach'),
      action: () => {
        closeMenu()
        fileInputRef.current?.click()
      },
    },
  ]

  if (platformMode && workspaceId) {
    menuItems.push({
      key: 'files',
      icon: <FolderOpen className="size-4" />,
      label: t('composer.menu.files'),
      action: () => {
        closeMenu()
        setFilePickerOpen(true)
      },
    })
    menuItems.push({
      key: 'memory',
      icon: <Brain className="size-4" />,
      label: t('composer.menu.memory'),
      action: () => {
        closeMenu()
        onNavigate?.('memory')
      },
    })
    menuItems.push({
      key: 'skills',
      icon: <Layers className="size-4" />,
      label: t('composer.menu.skills', { count: enabledSkillsCount }),
      action: () => {
        closeMenu()
        onNavigate?.('skills')
      },
    })
  }

  const renderMenuButtons = () =>
    menuItems.map((item) => (
      <button
        key={item.key}
        type="button"
        className="composer-menu-item"
        onClick={item.action}
      >
        {item.icon}
        <span>{item.label}</span>
      </button>
    ))

  return (
    <form className="composer composer-hmu" onSubmit={onSubmit}>
      <div className="composer-hmu-box">
        {showSlashPopover && (
          <SlashCommandPopover
            query={slashQuery ?? ''}
            commands={commandCatalog}
            onSelect={onSlashSelect}
            onClose={onSlashClose}
          />
        )}
        <PendingAttachments
          items={pending}
          onRemove={onRemovePending}
          onPreviewDoc={onPreviewDoc}
        />
        <div className="composer-hmu-input-container p-2.5">
        <textarea
          ref={textareaRef}
          className="composer-hmu-input"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={2}
          disabled={streaming}
        />
        </div>
        <div className="composer-hmu-toolbar">
          <div className="composer-hmu-left">
            {/* 模型选择：截图式 Popover 下拉（搜索 + 品牌色 + Pro/新 标签） */}
            <Popover open={modelOpen} onOpenChange={setModelOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="composer-model-trigger"
                  title={selectedModel || t('composer.model.pick')}
                  aria-label={t('composer.model.title')}
                >
                  <span className="composer-model-trigger-label truncate">
                    {selectedLabel}
                  </span>
                  <ChevronDown
                    className={cn(
                      'size-3.5 shrink-0 opacity-70 transition-transform',
                      modelOpen && 'rotate-180',
                    )}
                    aria-hidden
                  />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                sideOffset={8}
                className="composer-model-popover w-[min(20rem,calc(100vw-2rem))] p-0"
                onOpenAutoFocus={(e) => e.preventDefault()}
              >
                <div className="composer-model-search">
                  <Search className="size-4 shrink-0 opacity-50" aria-hidden />
                  <input
                    ref={searchInputRef}
                    type="search"
                    className="composer-model-search-input"
                    placeholder={t('composer.model.search')}
                    value={modelFilter}
                    onChange={(e) => setModelFilter(e.target.value)}
                    aria-label={t('composer.model.search')}
                  />
                </div>
                {usingFavorites && (
                  <p className="composer-model-fav-hint">
                    {t('composer.model.favoritesHint')}{' '}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        setModelOpen(false)
                        onNavigate?.('settings')
                      }}
                    >
                      {t('composer.model.favoritesEdit')}
                    </button>
                  </p>
                )}
                <div className="composer-model-scroll overlay-scrollbar">
                  {modelsLoading && (
                    <p className="composer-model-empty">{t('common.loading')}</p>
                  )}
                  {!modelsLoading && filteredModels.length === 0 && (
                    <p className="composer-model-empty">
                      {t('composer.model.empty')}
                    </p>
                  )}
                  {filteredModels.map((m) => {
                    const active = m.id === selectedModel
                    const badges = modelBadges(m.id)
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={cn(
                          'composer-model-option',
                          active && 'composer-model-option--active',
                        )}
                        onClick={() => {
                          onModelChange(m.id)
                          setModelOpen(false)
                        }}
                      >
                        <ModelBrandAvatar modelId={m.id} />
                        <span className="composer-model-option-text">
                          <span className="composer-model-option-name">
                            {modelDisplayName(m.id)}
                          </span>
                          {badges.length > 0 && (
                            <span className="composer-model-badges">
                              {badges.map((b) => (
                                <span
                                  key={b.kind}
                                  className={cn(
                                    'composer-model-badge',
                                    b.kind === 'pro' &&
                                      'composer-model-badge--pro',
                                    b.kind === 'new' &&
                                      'composer-model-badge--new',
                                  )}
                                >
                                  {t(`composer.model.badge.${b.labelKey}`)}
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </PopoverContent>
            </Popover>

            {mobile ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-expanded={menuOpen}
                aria-label={t('composer.menu.title')}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <Plus className="size-4" />
              </Button>
            ) : (
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('composer.menu.title')}
                  >
                    <Plus className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="start"
                  sideOffset={8}
                  className="composer-menu-dropdown min-w-[14rem]"
                >
                  {menuItems.map((item) => (
                    <DropdownMenuItem
                      key={item.key}
                      className="gap-2"
                      onSelect={() => item.action()}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <div className="composer-hmu-right">
            {streaming ? (
              <Button type="button" variant="secondary" size="sm" onClick={onStop}>
                <Square className="size-3.5" />
                {t('composer.stop')}
              </Button>
            ) : (
              <Button type="submit" size="sm" disabled={!canSend}>
                <Send className="size-3.5" />
                {t('composer.send')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {mobile && (
        <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
          <DialogContent className="composer-menu-sheet">
            <DialogHeader>
              <DialogTitle>{t('composer.menu.title')}</DialogTitle>
            </DialogHeader>
            <div className="composer-menu-panel composer-menu-panel--sheet">
              {renderMenuButtons()}
            </div>
          </DialogContent>
        </Dialog>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onPickFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {platformMode && workspaceId && (
        <FilePickerSheet
          open={filePickerOpen}
          onOpenChange={setFilePickerOpen}
          workspaceId={workspaceId}
          onConfirm={(picked) => {
            onAttachWorkspaceFiles(picked)
            setFilePickerOpen(false)
          }}
        />
      )}
    </form>
  )
}
