import { describe, expect, it, beforeEach } from 'vitest'

import {
  getLastWorkspaceTab,
  isWorkspaceRoute,
  mainTabFromRoute,
  parseRoute,
  routeHref,
  setLastWorkspaceTab,
  workspaceEntryRoute,
} from './routing'

describe('routing', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('parses known hash routes', () => {
    expect(parseRoute('#/settings')).toBe('settings')
    expect(parseRoute('#/files')).toBe('files')
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
  })

  it('detects workspace routes and main tabs', () => {
    expect(isWorkspaceRoute('files')).toBe(true)
    expect(isWorkspaceRoute('chat')).toBe(false)
    expect(mainTabFromRoute('skills')).toBe('workspace')
    expect(mainTabFromRoute('chat')).toBe('chat')
    expect(mainTabFromRoute('settings')).toBe('chat')
    expect(mainTabFromRoute('admin')).toBe('chat')
  })

  it('remembers last workspace sub-tab for entry', () => {
    expect(workspaceEntryRoute()).toBe('files')
    setLastWorkspaceTab('skills')
    expect(getLastWorkspaceTab()).toBe('skills')
    expect(workspaceEntryRoute()).toBe('skills')
  })
})
