"use client";

import Link from "next/link";
import {
  useTranslations,
  useLocale,
  useSetLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "@/lib/next-intl-stub";
import {
  useColorScheme,
  useSetColorScheme,
  type ColorScheme,
} from "@/lib/color-scheme";

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-[var(--fg-dim)]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function OptionButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-xl px-3 py-2 text-sm font-medium transition ${
        active
          ? "bg-[var(--accent)] text-[var(--accent-ink)]"
          : "bg-[var(--bg-elev-strong)] text-[var(--fg-muted)] hover:bg-[var(--border-strong)] hover:text-[var(--fg)]"
      }`}
    >
      {children}
    </button>
  );
}

const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: "English",
  ko: "한국어",
};

const COLOR_SCHEME_OPTIONS: ColorScheme[] = ["system", "light", "dark"];

export default function SettingsPage() {
  const t = useTranslations("settings");
  const locale = useLocale();
  const setLocale = useSetLocale();
  const colorScheme = useColorScheme();
  const setColorScheme = useSetColorScheme();

  const schemeLabel = (s: ColorScheme) => {
    if (s === "system") return t("colorSchemeSystem");
    if (s === "light") return t("colorSchemeLight");
    return t("colorSchemeDark");
  };

  return (
    <main className="mx-auto min-h-screen max-w-md px-4 pb-16 pt-16">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/"
          className="text-sm text-[var(--fg-muted)] transition hover:text-[var(--fg)]"
        >
          {t("backToEditor")}
        </Link>
      </div>

      <h1 className="mb-6 text-2xl font-bold">{t("title")}</h1>

      <div className="flex flex-col gap-4">
        {/* Language */}
        <SectionCard title={t("languageSection")}>
          <div className="flex gap-2">
            {SUPPORTED_LOCALES.map((loc) => (
              <OptionButton
                key={loc}
                active={locale === loc}
                onClick={() => setLocale(loc)}
              >
                {LOCALE_LABELS[loc]}
              </OptionButton>
            ))}
          </div>
        </SectionCard>

        {/* Color scheme */}
        <SectionCard title={t("colorSchemeSection")}>
          <div className="flex gap-2">
            {COLOR_SCHEME_OPTIONS.map((s) => (
              <OptionButton
                key={s}
                active={colorScheme === s}
                onClick={() => setColorScheme(s)}
              >
                {schemeLabel(s)}
              </OptionButton>
            ))}
          </div>
          {colorScheme === "system" && (
            <p className="mt-2 text-xs text-[var(--fg-dim)]">
              {t("colorSchemeSystemHint")}
            </p>
          )}
        </SectionCard>

        {/* About */}
        <SectionCard title={t("aboutSection")}>
          <p className="mb-3 text-sm text-[var(--fg-muted)]">
            {t("aboutDescription")}
          </p>
          <a
            href="https://github.com/powder-nomad/open-ski-data"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-[var(--accent)] transition hover:underline"
          >
            {t("aboutRepo")}
          </a>
          <p className="mt-3 text-xs text-[var(--fg-dim)]">{t("aboutLicense")}</p>
        </SectionCard>
      </div>
    </main>
  );
}
