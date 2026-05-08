import type { Config } from "tailwindcss";

/**
 * Tailwind config for the open-ski-data editor.
 *
 * The ported editor.tsx + mode-toolbar.tsx use Tailwind utility
 * classes with a CSS-variable theme (`--bg-surface`, `--bg-elev`,
 * `--accent`, `--accent-soft`, `--accent-ink`, `--border`, `--fg`,
 * `--fg-muted`, `--fg-dim`, etc.). The variables themselves are
 * defined in `src/app/globals.css`; Tailwind references them via
 * the `colors` extension below so utility classes like
 * `bg-[var(--accent)]` resolve at build time.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx,js,jsx,mdx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          surface: "var(--bg-surface)",
          elev: "var(--bg-elev)",
        },
        fg: {
          DEFAULT: "var(--fg)",
          muted: "var(--fg-muted)",
          dim: "var(--fg-dim)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          soft: "var(--accent-soft)",
          ink: "var(--accent-ink)",
        },
        border: "var(--border)",
      },
    },
  },
  plugins: [],
};

export default config;
