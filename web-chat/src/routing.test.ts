import { describe, expect, it, beforeEach } from 'vitest'

import {
  getLastWorkspaceTab,
  isWorkspaceRoute,
  mainTabFromRoute,
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
    expect(parseRoute('#/chat')).toBe('chat')
  })

  it('defaults unknown hashes to chat', () => {
    expect(parseRoute('')).toBe('chat')
    expect(parseRoute('#/unknown')).toBe('chat')
    expect(parseRoute('#chat')).toBe('chat')
  })

  it('builds hrefs', () => {
    expect(routeHref('settings')).toBe('#/settings')
    expect(routeHref('file-tags')).toBe('#/file-tags')
  })

  it('detects workspace routes and main tabs', () => {
    expect(isWorkspaceRoute('files')).toBe(true)
    expect(isWorkspaceRoute('file-tags')).toBe(true)
    expect(isWorkspaceRoute('chat')).toBe(false)
    expect(mainTabFromRoute('skills')).toBe('workspace')
    expect(mainTabFromRoute('file-tags')).toBe('workspace')
    expect(mainTabFromRoute('chat')).toBe('chat')
    expect(mainTabFromRoute('settings')).toBe('chat')
    expect(mainTabFromRoute('admin')).toBe('chat')
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
