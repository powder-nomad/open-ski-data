"use client";

/**
 * Minimal `next-intl`-compatible implementation, drop-in via the
 * `tsconfig.json` paths alias.
 *
 * Hydration strategy: both server-render AND initial client hydrate
 * use `en` (default). On mount, `LocaleProvider`'s `useEffect` reads
 * `navigator.language` and updates the context. React sees the
 * SSR-vs-CSR markup match on hydration (no #418), then re-renders
 * with the real locale.
 *
 * Trade-off: a brief (~50ms) visual flash of English before Korean
 * appears for ko-locale browsers. Acceptable for v1; the cleaner fix
 * (reading Accept-Language server-side via `headers()`) is blocked
 * by a @cloudflare/next-on-pages 1.13 bug — the auto-generated
 * `/_not-found` segment can't inherit `runtime = "edge"` from a
 * layout, so any layout doing `headers()` blocks the build.
 *
 * Lookup chain per call: requested locale → English fallback → key
 * literal (so missing translations are visible in review).
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import enMessages from "@/messages/en.json";
import koMessages from "@/messages/ko.json";

type MessageDict = Record<string, Record<string, string>>;
type LoadedMessages = MessageDict & { _meta?: unknown };

const DEFAULT_LOCALE = "en" as const;
export const SUPPORTED_LOCALES = ["en", "ko"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const ALL_MESSAGES: Record<SupportedLocale, LoadedMessages> = {
  en: enMessages as unknown as LoadedMessages,
  ko: koMessages as unknown as LoadedMessages,
};

const LS_KEY = "osd-edit:locale";

const LocaleContext = createContext<SupportedLocale>(DEFAULT_LOCALE);
const SetLocaleContext = createContext<(l: SupportedLocale) => void>(() => {});

function detectFromNavigator(): SupportedLocale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const tag = (navigator.language ?? DEFAULT_LOCALE).toLowerCase();
  for (const loc of SUPPORTED_LOCALES) {
    if (tag === loc || tag.startsWith(loc + "-")) return loc;
  }
  return DEFAULT_LOCALE;
}

function readStoredLocale(): SupportedLocale | null {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v && SUPPORTED_LOCALES.includes(v as SupportedLocale)) {
      return v as SupportedLocale;
    }
  } catch {}
  return null;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  // Initial value MUST match server render to avoid hydration #418.
  // Post-mount: prefer localStorage pick, then navigator auto-detect.
  const [locale, setLocaleState] = useState<SupportedLocale>(DEFAULT_LOCALE);

  useEffect(() => {
    const next = readStoredLocale() ?? detectFromNavigator();
    if (next !== locale) setLocaleState(next);
    if (typeof document !== "undefined") {
      document.documentElement.lang = next;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLocale = (next: SupportedLocale) => {
    try { localStorage.setItem(LS_KEY, next); } catch {}
    setLocaleState(next);
    if (typeof document !== "undefined") {
      document.documentElement.lang = next;
    }
  };

  return (
    <SetLocaleContext.Provider value={setLocale}>
      <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
    </SetLocaleContext.Provider>
  );
}

/** Returns a setter that persists the chosen locale to localStorage. */
export function useSetLocale(): (l: SupportedLocale) => void {
  return useContext(SetLocaleContext);
}

function interpolate(
  template: string,
  values?: Record<string, unknown>,
): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in values ? String(values[key]) : `{${key}}`,
  );
}

export function useTranslations(namespace?: string) {
  const locale = useContext(LocaleContext);
  const ns = namespace ?? "";
  return (key: string, values?: Record<string, unknown>): string => {
    const localized = ALL_MESSAGES[locale]?.[ns]?.[key];
    const fallback = ALL_MESSAGES[DEFAULT_LOCALE]?.[ns]?.[key];
    const template = localized ?? fallback;
    if (typeof template !== "string") return key;
    return interpolate(template, values);
  };
}

export function useLocale(): SupportedLocale {
  return useContext(LocaleContext);
}
