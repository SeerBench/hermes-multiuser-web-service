import { describe, expect, it, beforeEach } from 'vitest'
import {
  consumeFilesForChat,
  queueFilesForChat,
  sendFileToChat,
} from './attachBridge'

describe('attachBridge', () => {
  beforeEach(() => {
    sessionStorage.clear()
    window.location.hash = ''
  })

  it('queues and consumes files once', () => {
    queueFilesForChat([
      { name: 'a.pdf', path: 'uploads/a.pdf', size: 12 },
    ])
    expect(consumeFilesForChat()).toEqual([
      { name: 'a.pdf', path: 'uploads/a.pdf', size: 12 },
    ])
    expect(consumeFilesForChat()).toEqual([])
  })

  it('sendFileToChat stores bridge and navigates to chat', () => {
    sendFileToChat({ name: 'b.txt', path: 'uploads/b.txt', size: 3 })
    expect(window.location.hash).toBe('#/chat')
    expect(consumeFilesForChat()[0]?.name).toBe('b.txt')
  })
})
