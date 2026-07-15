import { Button } from '@/components/ui/button'
import { useT } from '../i18n'

type Props = {
  onPickSuggestion: (text: string) => void
  onGoFiles?: () => void
  onGoSkills?: () => void
  onGoSettings?: () => void
  needsBindKey?: boolean
  hasModel?: boolean
  platformMode?: boolean
  enabledSkillsCount?: number
}

/** Empty-chat onboarding guide: suggestions + workspace shortcuts. */
export function ChatEmptyGuide({
  onPickSuggestion,
  onGoFiles,
  onGoSkills,
  onGoSettings,
  needsBindKey,
  hasModel = true,
  platformMode,
  enabledSkillsCount = 0,
}: Props) {
  const t = useT()
  const suggestions = [
    t('chat.empty.suggest.1'),
    t('chat.empty.suggest.2'),
    t('chat.empty.suggest.3'),
  ]

  return (
    <div className="chat-empty-guide">
      <h2 className="chat-empty-guide-title">{t('chat.empty.title')}</h2>
      <p className="chat-empty-guide-sub">{t('chat.empty.subtitle')}</p>

      {(needsBindKey || (platformMode && !hasModel)) && (
        <div className="chat-empty-guide-alerts" role="status">
          {needsBindKey && (
            <button type="button" className="chat-empty-guide-alert" onClick={onGoSettings}>
              {t('chat.empty.check.bind')}
            </button>
          )}
          {platformMode && !hasModel && !needsBindKey && (
            <button type="button" className="chat-empty-guide-alert" onClick={onGoSettings}>
              {t('chat.empty.check.model')}
            </button>
          )}
        </div>
      )}

      <div className="chat-empty-guide-suggestions">
        <p className="chat-empty-guide-label">{t('chat.empty.suggestions')}</p>
        <div className="chat-empty-guide-chips">
          {suggestions.map((text) => (
            <Button
              key={text}
              type="button"
              variant="outline"
              size="sm"
              className="chat-empty-guide-chip"
              onClick={() => onPickSuggestion(text)}
            >
              {text}
            </Button>
          ))}
        </div>
      </div>

      {platformMode && (
        <div className="chat-empty-guide-actions">
          <Button type="button" variant="secondary" size="sm" onClick={onGoFiles}>
            {t('chat.empty.action.files')}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onGoSkills}>
            {t('chat.empty.action.skills')}
          </Button>
          {enabledSkillsCount > 0 && (
            <span className="chat-empty-guide-meta">
              {t('chat.skills.count', { count: enabledSkillsCount })}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
