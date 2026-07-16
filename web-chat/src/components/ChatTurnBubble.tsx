import { ActivityLog } from './ActivityLog'
import { AttachmentList } from './AttachmentChips'
import { MarkdownContent } from './MarkdownContent'
import { MessageActions } from './MessageActions'
import { ReasoningPanel } from './ReasoningPanel'
import { ToolEvent } from './ToolEvent'
import { Avatar, AvatarImage } from '@/components/ui/avatar'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from '@/components/ui/message'
import { cn } from '@/lib/utils'
import { useT } from '../i18n'
import { turnToCopyText, type Turn } from '../chatTurns'

/** One chat turn: shadcn Message + optional user Avatar + Bubble. */
export function ChatTurnBubble({
  turn,
  onRetry,
  onEdit,
  userAvatarUrl,
}: {
  turn: Turn
  onRetry?: () => void
  onEdit?: () => void
  /** Custom profile image; only shown on user turns when set. */
  userAvatarUrl?: string | null
}) {
  const t = useT()
  const isUser = turn.role === 'user'
  const align = isUser ? 'end' : 'start'
  // User: primary bubble; assistant: ghost (markdown flush with the column).
  const variant = isUser ? 'default' : 'ghost'
  // Hermes never shows an avatar; user only when they set one in Settings.
  const showAvatar = isUser && Boolean(userAvatarUrl?.trim())

  return (
    <Message align={align} className={`turn turn-${turn.role}`}>
      {showAvatar && (
        <MessageAvatar>
          {/* 全站用户头像统一 32×32（Avatar default = size-8） */}
          <Avatar>
            <AvatarImage src={userAvatarUrl!} alt="" />
          </Avatar>
        </MessageAvatar>
      )}

      <MessageContent className={isUser ? 'max-w-[min(100%,42rem)]' : undefined}>
        <MessageHeader>
          {isUser ? t('chat.role.user') : t('chat.role.assistant')}
          {turn.usage && turn.role === 'assistant' && (
            <span className="turn-usage ms-2" aria-label="token usage">
              ↑{turn.usage.input_tokens ?? 0} ↓{turn.usage.output_tokens ?? 0}
            </span>
          )}
        </MessageHeader>

        {!isUser && (
          <ActivityLog
            items={turn.activity}
            streaming={turn.status === 'streaming'}
          />
        )}
        {turn.reasoning && (
          <ReasoningPanel
            text={turn.reasoning}
            streaming={turn.status === 'streaming'}
          />
        )}

        {turn.segments.map((seg, i) => {
          if (seg.kind === 'tool') {
            return (
              <ToolEvent
                key={`${turn.id}-seg-${i}`}
                tool={seg.tool}
                preview={seg.preview}
                args={seg.args}
                result_preview={seg.result_preview}
                duration={seg.duration}
                error={seg.error}
              />
            )
          }
          if (seg.kind === 'system') {
            return (
              <div
                key={`${turn.id}-seg-${i}`}
                className={`turn-system${
                  seg.tone === 'error' ? ' turn-system-error' : ''
                }`}
              >
                <span className="turn-system-prefix">
                  {t('command.system.prefix')}
                </span>
                <pre>{seg.text}</pre>
              </div>
            )
          }
          return (
            <Bubble
              key={`${turn.id}-seg-${i}`}
              variant={variant}
              align={align}
              className={isUser ? undefined : 'w-full max-w-full'}
            >
              <BubbleContent
                className={cn(
                  isUser
                    ? 'bg-primary text-primary-foreground [&_*]:text-primary-foreground'
                    : 'w-full max-w-full',
                )}
              >
                {turn.role === 'assistant' ? (
                  <MarkdownContent text={seg.text || '…'} />
                ) : (
                  <div className="whitespace-pre-wrap wrap-break-word">
                    {seg.text}
                  </div>
                )}
              </BubbleContent>
            </Bubble>
          )
        })}

        {turn.attachments && turn.attachments.length > 0 && (
          <AttachmentList items={turn.attachments} />
        )}
        {turn.status === 'streaming' && turn.segments.length === 0 && (
          <Bubble variant={variant} align={align}>
            <BubbleContent
              className={
                isUser
                  ? 'bg-primary text-primary-foreground'
                  : undefined
              }
            >
              <em>…</em>
            </BubbleContent>
          </Bubble>
        )}
        {turn.status === 'error' && (
          <div className="turn-error">{turn.errorMessage}</div>
        )}

        {turn.status === 'done' && (
          <MessageFooter>
            <MessageActions
              copyText={turnToCopyText(turn)}
              onRetry={turn.role === 'assistant' ? onRetry : undefined}
              onEdit={turn.role === 'user' ? onEdit : undefined}
              shareable={turn.role === 'assistant'}
            />
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  )
}
