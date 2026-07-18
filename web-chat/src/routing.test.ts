import { describe, expect, it, beforeEach } from 'vitest'

import {
  getLastWorkspaceTab,
  isAdminRoute,
  isWorkspaceRoute,
  mainTabFromRoute,
  parseResetToken,
  parseRoute,
  routeHref,
  setLastWorkspaceTab,
  workspaceEntryRoute,
  workspaceShellTab,
} from './routing'

describe('routing', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('parses known hash routes', () => {
    expect(parseRoute('#/settings')).toBe('settings')
    expect(parseRoute('#/files')).toBe('files')
    expect(parseRoute('#/file-tags')).toBe('file-tags')
    expect(parseRoute('#/memory')).toBe('memory')
    expect(parseRoute('#/skills')).toBe('skills')
    expect(parseRoute('#/admin')).toBe('admin')
    expect(parseRoute('#/admin/audit')).toBe('admin-audit')
    expect(parseRoute('#/reset-password')).toBe('reset-password')
    expect(parseRoute('#/reset-password?token=abc')).toBe('reset-password')
    expect(parseRoute('#/chat')).toBe('chat')
  })

  it('parses reset token from hash query', () => {
    expect(parseResetToken('#/reset-password?token=abc123')).toBe('abc123')
    expect(parseResetToken('#/chat')).toBe(null)
  })

  it('defaults unknown hashes to chat', () => {
    expect(parseRoute('')).toBe('chat')
    expect(parseRoute('#/unknown')).toBe('chat')
    expect(parseRoute('#chat')).toBe('chat')
  })

  it('builds hrefs', () => {
    expect(routeHref('settings')).toBe('#/settings')
    expect(routeHref('file-tags')).toBe('#/file-tags')
    expect(routeHref('admin-audit')).toBe('#/admin/audit')
  })

  it('detects workspace routes and main tabs', () => {
    expect(isWorkspaceRoute('files')).toBe(true)
    expect(isWorkspaceRoute('file-tags')).toBe(true)
    expect(isWorkspaceRoute('chat')).toBe(false)
    expect(isAdminRoute('admin')).toBe(true)
    expect(isAdminRoute('admin-audit')).toBe(true)
    expect(isAdminRoute('chat')).toBe(false)
    expect(mainTabFromRoute('skills')).toBe('workspace')
    expect(mainTabFromRoute('file-tags')).toBe('workspace')
    expect(mainTabFromRoute('chat')).toBe('chat')
    expect(mainTabFromRoute('settings')).toBe('chat')
    expect(mainTabFromRoute('admin')).toBe('chat')
    expect(mainTabFromRoute('admin-audit')).toBe('chat')
  })

  it('maps file-tags into the Files shell tab', () => {
    expect(workspaceShellTab('files')).toBe('files')
    expect(workspaceShellTab('file-tags')).toBe('files')
    expect(workspaceShellTab('skills')).toBe('skills')
    expect(workspaceShellTab('chat')).toBe(null)
  })

  it('remembers last workspace sub-tab for entry', () => {
    expect(workspaceEntryRoute()).toBe('files')
    setLastWorkspaceTab('skills')
    expect(getLastWorkspaceTab()).toBe('skills')
    expect(workspaceEntryRoute()).toBe('skills')
  })
})
