import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LocaleProvider } from '../i18n'
import { ChatPage } from './ChatPage'

vi.mock('../platformClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platformClient')>()
  return {
    ...actual,
    getStoredWorkspaceId: vi.fn(() => 'ws-1'),
    platform: {
      ...actual.platform,
      listModels: vi.fn().mockResolvedValue({
        models: [{ id: 'gpt-5.6-luna' }, { id: 'claude-sonnet-4.6' }],
        preferred_model: 'gpt-5.6-luna',
      }),
      listSkills: vi.fn().mockResolvedValue([]),
      patchPreferences: vi.fn().mockResolvedValue(undefined),
    },
  }
})

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    auth: {
      me: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
    },
    conversations: {
      list: vi.fn(),
      get: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      setFlags: vi.fn(),
    },
    commands: {
      list: vi.fn(),
      run: vi.fn(),
    },
    uploads: {
      create: vi.fn(),
    },
    streamChat: vi.fn(),
  }
})

import {
  ApiError,
  auth,
  commands as commandsApi,
  conversations as convosApi,
  streamChat,
} from '../api'
import { platform } from '../platformClient'

const mockUser = {
  user_id: 'u_test',
  created_at: 1_700_000_000,
  last_seen_at: 1_700_000_100,
  email: 'chat@example.com',
}

function renderChat(
  props: {
    platformMode?: boolean
    signedIn?: boolean
    needsBindKey?: boolean
    onGoBindSettings?: () => void
    userAvatarUrl?: string | null
  } = {},
) {
  return render(
    <LocaleProvider>
      <ChatPage {...props} />
    </LocaleProvider>,
  )
}

function mockAuthedChat() {
  vi.mocked(auth.me).mockResolvedValue(mockUser)
  vi.mocked(convosApi.list).mockResolvedValue([])
  vi.mocked(commandsApi.list).mockResolvedValue([])
}

describe('ChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(platform.listModels).mockResolvedValue({
      models: [{ id: 'gpt-5.6-luna' }, { id: 'claude-sonnet-4.6' }],
      preferred_model: 'gpt-5.6-luna',
    })
    vi.mocked(platform.listSkills).mockResolvedValue([])
  })

  it('opens key modal when legacy auth probe returns 401', async () => {
    vi.mocked(auth.me).mockRejectedValue(new ApiError('unauthorized', 401))

    renderChat()

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /sign in with your api key/i }),
    ).toBeInTheDocument()
  })

  it('renders empty state for platform signed-in users', async () => {
    mockAuthedChat()
    renderChat({ signedIn: true })

    const title = await screen.findByText(/start a new conversation/i)
    expect(title).toBeInTheDocument()
    expect(title.closest('[data-slot="message-scroller-item"]')).toHaveClass(
      'chat-empty-guide-item',
    )
    expect(screen.getByPlaceholderText(/start with any idea/i)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does not open key modal when signedIn even if auth.me fails', async () => {
    vi.mocked(auth.me).mockRejectedValue(new ApiError('unauthorized', 401))
    vi.mocked(convosApi.list).mockResolvedValue([])
    vi.mocked(commandsApi.list).mockResolvedValue([])

    renderChat({ signedIn: true })

    await waitFor(() => {
      expect(screen.getByText(/start a new conversation/i)).toBeInTheDocument()
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('includes the selected model when sending in platform mode', async () => {
    const user = userEvent.setup()
    mockAuthedChat()
    vi.mocked(streamChat).mockImplementation(async function* () {
      yield {
        type: 'done',
        session_id: 'sess-model',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }
    })

    renderChat({ signedIn: true, platformMode: true })
    await screen.findByPlaceholderText(/start with any idea/i)
    await waitFor(() => {
      expect(platform.listModels).toHaveBeenCalledWith('ws-1')
    })
    expect(
      await screen.findByRole('button', { name: /choose model/i }),
    ).toHaveTextContent(/gpt 5\.6 luna/i)

    await user.type(screen.getByPlaceholderText(/start with any idea/i), 'Hi there')
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Hi there',
        model: 'gpt-5.6-luna',
      }),
      expect.any(AbortSignal),
    )
  })

  it('streams assistant tokens after send', async () => {
    const user = userEvent.setup()
    mockAuthedChat()
    vi.mocked(streamChat).mockImplementation(async function* () {
      yield { type: 'token', text: 'Hello ' }
      yield { type: 'token', text: 'world' }
      yield {
        type: 'done',
        session_id: 'sess-int',
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      }
    })

    renderChat({ signedIn: true })
    await screen.findByPlaceholderText(/start with any idea/i)

    await user.type(screen.getByPlaceholderText(/start with any idea/i), 'Hi there')
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    expect(await screen.findByText(/hello world/i)).toBeInTheDocument()
    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Hi there' }),
      expect.any(AbortSignal),
    )
  })

  it('blocks send when upstream key is not bound', async () => {
    const onGoBindSettings = vi.fn()
    const user = userEvent.setup()
    mockAuthedChat()
    renderChat({ signedIn: true, needsBindKey: true, onGoBindSettings })

    await screen.findByPlaceholderText(/start with any idea/i)
    expect(screen.getByText(/disabled until you bind/i)).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText(/start with any idea/i), 'Hi')
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    expect(streamChat).not.toHaveBeenCalled()
    expect(onGoBindSettings).toHaveBeenCalled()
  })

  it('surfaces SSE error events on the assistant turn', async () => {
    const user = userEvent.setup()
    mockAuthedChat()
    vi.mocked(streamChat).mockImplementation(async function* () {
      yield { type: 'error', message: 'upstream down', code: 'agent_error' }
    })

    renderChat({ signedIn: true })
    await screen.findByPlaceholderText(/start with any idea/i)

    await user.type(screen.getByPlaceholderText(/start with any idea/i), 'fail please')
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    expect(await screen.findByText(/upstream down/i)).toBeInTheDocument()
  })
})
