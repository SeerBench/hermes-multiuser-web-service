import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import {
  Brain,
  FolderOpen,
  Layers,
  Paperclip,
  Plus,
  Send,
  Sparkles,
  Square,
} from 'lucide-react'
import { PendingAttachments, type PendingAttachment } from './AttachmentChips'
import { SlashCommandPopover } from './SlashCommandPopover'
import type { CommandSpec } from '../api'
import { useT } from '../i18n'
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
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
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
  onAttachWorkspaceFiles: (paths: { name: string; path: string; size: number }[]) => void
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
  onNavigate?: (route: 'memory' | 'skills' | 'files') => void
  enabledSkillsCount?: number
}

type MenuItem = {
  key: string
  icon: ReactNode
  label: string
  action: () => void
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
  onNavigate,
  enabledSkillsCount = 0,
}: ChatComposerProps) {
  const t = useT()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [modelFilter, setModelFilter] = useState('')
  const [mobile, setMobile] = useState(false)

  useEffect(() => subscribeViewport(setMobile), [])

  const canSend =
    !streaming &&
    !uploading &&
    (input.trim().length > 0 ||
      pending.some((p) => p.status === 'done' && p.path))

  const filteredModels = models.filter((m) =>
    m.id.toLowerCase().includes(modelFilter.toLowerCase()),
  )

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
      label: t('composer.menu.workspaceFiles'),
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
        <PendingAttachments items={pending} onRemove={onRemovePending} />
        <textarea
          className="composer-hmu-input"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={mobile ? 2 : 3}
          disabled={streaming}
        />
        <div className="composer-hmu-toolbar">
          <div className="composer-hmu-left">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="composer-model-btn"
              title={selectedModel || t('composer.model.pick')}
              onClick={() => setModelOpen(true)}
            >
              <Sparkles className="size-4" />
            </Button>
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
              /* Portal dropdown — avoids clipping by composer-hmu-box overflow */
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

      <Dialog open={modelOpen} onOpenChange={setModelOpen}>
        <DialogContent className="composer-model-dialog">
          <DialogHeader>
            <DialogTitle>{t('composer.model.title')}</DialogTitle>
          </DialogHeader>
          <Input
            placeholder={t('composer.model.search')}
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
          />
          <ScrollArea className="composer-model-list">
            {modelsLoading && <p className="page-hint">{t('common.loading')}</p>}
            {!modelsLoading && filteredModels.length === 0 && (
              <p className="page-hint">{t('composer.model.empty')}</p>
            )}
            {filteredModels.map((m) => (
              <button
                key={m.id}
                type="button"
                className={cn(
                  'composer-model-row',
                  m.id === selectedModel && 'composer-model-row--active',
                )}
                onClick={() => {
                  onModelChange(m.id)
                  setModelOpen(false)
                }}
              >
                <span>{m.id}</span>
                {m.owned_by && (
                  <small className="composer-model-owned">{m.owned_by}</small>
                )}
              </button>
            ))}
          </ScrollArea>
          {selectedModel && (
            <p className="page-hint">
              {t('composer.model.current', { model: selectedModel })}
            </p>
          )}
        </DialogContent>
      </Dialog>

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
