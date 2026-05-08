/**
 * Minimal `next-intl`-compatible implementation, drop-in replaces
 * the upstream package via `tsconfig.json` `paths` so the editor
 * doesn't need to know we're not running real next-intl.
 *
 * What it does:
 *   - Loads `@/messages/<locale>.json` at module-load time
 *   - Exposes `useTranslations(namespace)` returning `(key, values?) => string`
 *   - Resolves `{name}`-style interpolation tokens (next-intl-compatible)
 *   - Falls back to the literal key if a string is missing — same UX
 *     as next-intl's "missing translation" dev mode, makes typos
 *     visible in the rendered UI
 *
 * What it doesn't do (yet):
 *   - Locale switching (`useLocale()` always returns "en")
 *   - Pluralization, date/number formatting, ICU MessageFormat
 *   - Server-rendering bridge (this is purely client + edge-friendly)
 *
 * When we want real i18n: install `next-intl`, drop the path remap
 * from tsconfig.json, port `messages/{ko,ja}.json` (en.json is
 * already the right shape), wire `NextIntlClientProvider` in
 * `app/layout.tsx`. The editor surface won't need to change because
 * we kept the API identical.
 */

import enMessages from "@/messages/en.json";

type MessageDict = Record<string, Record<string, string>>;

// JSON's `_meta` key is intentionally typed as `unknown` — tooling
// metadata for human readers, never indexed at runtime.
type LoadedMessages = MessageDict & { _meta?: unknown };

const DEFAULT_LOCALE = "en";

const ALL_MESSAGES: Record<string, LoadedMessages> = {
  [DEFAULT_LOCALE]: enMessages as unknown as LoadedMessages,
};

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
  const ns = namespace ?? "";
  return (key: string, values?: Record<string, unknown>): string => {
    const dict = ALL_MESSAGES[DEFAULT_LOCALE]?.[ns] ?? {};
    const template = dict[key];
    if (typeof template !== "string") {
      // Surface missing keys as the literal key (e.g. "pickMode")
      // rather than throwing — keeps the UI rendering even when the
      // translation table drifts behind the editor.
      return key;
    }
    return interpolate(template, values);
  };
}

export function useLocale(): string {
  return DEFAULT_LOCALE;
}
