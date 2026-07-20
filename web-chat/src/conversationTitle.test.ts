import { describe, expect, it } from 'vitest'
import { provisionalTitleFromMessage } from './conversationTitle'

describe('provisionalTitleFromMessage', () => {
  it('returns empty for blank input', () => {
    expect(provisionalTitleFromMessage('  \n')).toBe('')
  })

  it('keeps short messages intact', () => {
    expect(provisionalTitleFromMessage('Hello world')).toBe('Hello world')
  })

  it('truncates long messages with ellipsis', () => {
    const long = 'a'.repeat(60)
    const title = provisionalTitleFromMessage(long, 20)
    expect(title.length).toBeLessThanOrEqual(20)
    expect(title.endsWith('…')).toBe(true)
  })
})
