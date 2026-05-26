import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import enDict from './en.json'
import zhDict from './zh.json'

export type Locale = 'en' | 'zh'

type Dict = Record<string, string>

const DICTIONARIES: Record<Locale, Dict> = {
  en: enDict as Dict,
  zh: zhDict as Dict,
}

const STORAGE_KEY = 'hermes-locale'

function detectInitialLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'en' || stored === 'zh') return stored
  } catch {
    // localStorage unavailable (private mode, file://, etc.) — fall through.
  }
  const nav = (typeof navigator !== 'undefined' && navigator.language) || ''
  if (nav.toLowerCase().startsWith('zh')) return 'zh'
  return 'en'
}

type Vars = Record<string, string | number>

export type Translator = (key: string, vars?: Vars) => string

type LocaleContextValue = {
  locale: Locale
  setLocale: (next: Locale) => void
  t: Translator
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name]
    return v === undefined || v === null ? `{${name}}` : String(v)
  })
}

function translate(locale: Locale, key: string, vars?: Vars): string {
  const dict = DICTIONARIES[locale]
  const fallback = DICTIONARIES.en
  const raw = dict[key] ?? fallback[key] ?? key
  return interpolate(raw, vars)
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectInitialLocale())

  // Keep the <html lang> attribute in sync so the browser picks the
  // right hyphenation rules, font-language fallbacks, etc.
  useEffect(() => {
    try {
      document.documentElement.lang = locale
    } catch {
      // ignore — SSR safety
    }
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // ignore — best-effort persistence
    }
  }, [])

  const t = useCallback<Translator>(
    (key, vars) => translate(locale, key, vars),
    [locale],
  )

  const value = useMemo(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  )

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useT(): Translator {
  const ctx = useContext(LocaleContext)
  if (!ctx) {
    // Out-of-tree safety net — useful for unit tests / Storybook.
    return (key, vars) => translate('en', key, vars)
  }
  return ctx.t
}

export function useLocale(): { locale: Locale; setLocale: (l: Locale) => void } {
  const ctx = useContext(LocaleContext)
  if (!ctx) {
    return { locale: 'en', setLocale: () => undefined }
  }
  return { locale: ctx.locale, setLocale: ctx.setLocale }
}
