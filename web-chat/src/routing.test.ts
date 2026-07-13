import { describe, expect, it } from 'vitest'

import { parseRoute, routeHref } from './routing'

describe('routing', () => {
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
})
