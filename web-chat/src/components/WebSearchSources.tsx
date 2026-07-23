import { useState } from 'react'
import { XIcon } from 'lucide-react'
import { useT } from '../i18n'
import {
  collectTurnSearchHits,
  faviconUrlForSite,
  type WebSearchHit,
} from '../toolEventUtils'
import type { Segment } from '../chatTurns'
import { Button } from '@/components/ui/button'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { cn } from '@/lib/utils'

const MAX_ICONS = 3

function SiteIcon({ hit }: { hit: WebSearchHit }) {
  const [broken, setBroken] = useState(false)
  const src = faviconUrlForSite(hit.url)
  let host = hit.url
  try {
    host = new URL(hit.url).hostname
  } catch {
    // keep raw
  }
  if (!src || broken) {
    return (
      <span
        className="web-search-source-ico web-search-source-ico--fallback"
        aria-hidden
      >
        {host.slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return (
    <img
      className="web-search-source-ico"
      src={src}
      alt=""
      width={20}
      height={20}
      loading="lazy"
      onError={() => setBroken(true)}
    />
  )
}

/**
 * 助手回复操作行内「来源」：最多 3 个站点 ICO，点击从右侧滑出 Drawer。
 */
export function WebSearchSources({
  segments,
  className,
}: {
  segments: Segment[]
  className?: string
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const hits = collectTurnSearchHits(segments)
  if (hits.length === 0) return null

  const icons = hits.slice(0, MAX_ICONS)

  return (
    <>
      <button
        type="button"
        className={cn('web-search-sources', className)}
        onClick={() => setOpen(true)}
        aria-label={t('chat.sources.open', { n: hits.length })}
        title={t('chat.sources.open', { n: hits.length })}
      >
        <span className="web-search-sources-icos" aria-hidden>
          {icons.map((hit) => (
            <SiteIcon key={hit.url} hit={hit} />
          ))}
        </span>
        {hits.length > MAX_ICONS && (
          <span className="web-search-sources-more">+{hits.length - MAX_ICONS}</span>
        )}
      </button>

      <Drawer
        open={open}
        onOpenChange={setOpen}
        direction="right"
        shouldScaleBackground={false}
      >
        <DrawerContent className="web-search-sources-drawer flex h-full max-h-screen flex-col">
          <DrawerHeader className="shrink-0 border-b text-left">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <DrawerTitle>{t('chat.sources.title')}</DrawerTitle>
                <DrawerDescription>
                  {t('chat.sources.desc', { n: hits.length })}
                </DrawerDescription>
              </div>
              <DrawerClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('common.close')}
                >
                  <XIcon className="size-4" />
                </Button>
              </DrawerClose>
            </div>
          </DrawerHeader>

          <ul className="web-search-sources-list min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4">
            {hits.map((hit) => (
              <li key={hit.url} className="flex items-start gap-3">
                <SiteIcon hit={hit} />
                <div className="min-w-0 flex-1">
                  <a
                    href={hit.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-sm wrap-break-word hover:underline"
                  >
                    {hit.title}
                  </a>
                  <p className="text-xs text-muted-foreground truncate">{hit.url}</p>
                </div>
              </li>
            ))}
          </ul>
        </DrawerContent>
      </Drawer>
    </>
  )
}
