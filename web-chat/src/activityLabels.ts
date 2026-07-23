import type { ActivityItem } from './components/ActivityLog'
import type { Translator } from './i18n'

/** 将活动日志条目格式化为展示文案。 */
export function activityItemLabel(t: Translator, item: ActivityItem): string {
  if (item.kind === 'step') {
    return item.tools.length
      ? t('activity.step.tools', { n: item.step, tools: item.tools.join(', ') })
      : t('activity.step', { n: item.step })
  }
  if (item.kind === 'thinking') {
    return t('activity.thinking', { text: item.text })
  }
  return item.text
}
