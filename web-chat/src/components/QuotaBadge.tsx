import type { Quota } from '../api'

type Props = {
  quota: Quota
}

export function QuotaBadge({ quota }: Props) {
  const pct = quota.limit > 0 ? (quota.used / quota.limit) * 100 : 0
  const tone =
    quota.exceeded ? 'badge-over' : pct >= 80 ? 'badge-warn' : 'badge-ok'

  return (
    <span className={`quota-badge ${tone}`} title={`${quota.used.toLocaleString()} / ${quota.limit.toLocaleString()} tokens`}>
      {quota.exceeded ? 'over quota' : `${formatTokens(quota.remaining)} left`}
    </span>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}
