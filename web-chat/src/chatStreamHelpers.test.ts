import { describe, expect, it } from 'vitest'

import type { Turn } from './chatTurns'
import {
  appendToken,
  pushActivity,
  turnHasText,
  updateAssistant,
} from './chatStreamHelpers'

const assistantTurn = (segments: Turn['segments'] = []): Turn => ({
  id: 'a1',
  role: 'assistant',
  status: 'streaming',
  activity: [],
  segments,
})

const userTurn: Turn = {
  id: 'u1',
  role: 'user',
  status: 'done',
  activity: [],
  segments: [{ kind: 'text', text: 'hi' }],
}

describe('updateAssistant', () => {
  it('updates the last assistant turn', () => {
    const prev = [userTurn, assistantTurn()]
    const next = updateAssistant(prev, (t) => ({ ...t, status: 'done' }))
    expect(next[1].status).toBe('done')
    expect(next[0]).toBe(userTurn)
  })

  it('no-ops when last turn is not assistant', () => {
    const prev = [userTurn]
    expect(updateAssistant(prev, (t) => ({ ...t, status: 'done' }))).toBe(prev)
  })
})

describe('appendToken', () => {
  it('appends to existing text segment', () => {
    const turn = assistantTurn([{ kind: 'text', text: 'hel' }])
    expect(appendToken(turn, 'lo').segments[0]).toEqual({
      kind: 'text',
      text: 'hello',
    })
  })

  it('creates a new text segment when needed', () => {
    const turn = assistantTurn([{ kind: 'system', text: 'sys' }])
    expect(appendToken(turn, 'x').segments[1]).toEqual({
      kind: 'text',
      text: 'x',
    })
  })
})

describe('pushActivity', () => {
  it('appends activity to assistant turn', () => {
    const item = { kind: 'status' as const, text: 'thinking', ts: 1 }
    const next = pushActivity([assistantTurn()], item)
    expect(next[0].activity).toEqual([item])
  })
})

describe('turnHasText', () => {
  it('detects text and system segments', () => {
    expect(turnHasText(assistantTurn([{ kind: 'text', text: 'x' }]))).toBe(true)
    expect(turnHasText(assistantTurn([{ kind: 'system', text: 'y' }]))).toBe(true)
    expect(turnHasText(assistantTurn())).toBe(false)
  })
})
