import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import { LocaleProvider } from '../i18n'
import { MemoryPage } from './MemoryPage'

vi.mock('../components/MarkdownEditor', () => ({
  MarkdownEditor: ({
    value,
    onChange,
  }: {
    value: string
    onChange: (v: string) => void
  }) => (
    <textarea
      aria-label="memory-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

vi.mock('../platformClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platformClient')>()
  return {
    ...actual,
    getStoredWorkspaceId: () => 'ws-1',
    platform: {
      ...actual.platform,
      getMemory: vi.fn(),
      patchMemory: vi.fn(),
    },
  }
})

import { platform } from '../platformClient'

describe('MemoryPage toast feedback', () => {
  beforeEach(() => {
    localStorage.setItem('hermes-locale', 'en')
    vi.mocked(platform.getMemory).mockResolvedValue({
      long_term: 'old memory',
      profile: 'old profile',
    })
    vi.mocked(platform.patchMemory).mockResolvedValue({
      status: 'ok',
    })
  })

  it('shows a success toast after saving memory', async () => {
    const user = userEvent.setup()
    const successSpy = vi.spyOn(toast, 'success')

    render(
      <LocaleProvider>
        <MemoryPage />
      </LocaleProvider>,
    )

    const editors = await screen.findAllByLabelText('memory-editor')
    await user.clear(editors[0])
    await user.type(editors[0], 'new memory')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(platform.patchMemory).toHaveBeenCalled()
      expect(successSpy).toHaveBeenCalledWith('Saved.')
    })
  })
})
