"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type ColorScheme = "system" | "light" | "dark";
const LS_KEY = "osd-edit:color-scheme";

const ColorSchemeContext = createContext<ColorScheme>("system");
const SetColorSchemeContext = createContext<(s: ColorScheme) => void>(() => {});

function applyTheme(scheme: ColorScheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (scheme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", scheme);
  }
}

function readStored(): ColorScheme {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  return "system";
}

export function ColorSchemeProvider({ children }: { children: ReactNode }) {
  const [scheme, setSchemeState] = useState<ColorScheme>("system");

  useEffect(() => {
    const stored = readStored();
    setSchemeState(stored);
    applyTheme(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setScheme = (next: ColorScheme) => {
    try { localStorage.setItem(LS_KEY, next); } catch {}
    setSchemeState(next);
    applyTheme(next);
  };

  return (
    <SetColorSchemeContext.Provider value={setScheme}>
      <ColorSchemeContext.Provider value={scheme}>
        {children}
      </ColorSchemeContext.Provider>
    </SetColorSchemeContext.Provider>
  );
}

export function useColorScheme(): ColorScheme {
  return useContext(ColorSchemeContext);
}

export function useSetColorScheme(): (s: ColorScheme) => void {
  return useContext(SetColorSchemeContext);
}

/**
 * Inline script placed in <head> before any CSS or React hydration.
 * Reads localStorage and stamps data-theme on <html> immediately so
 * there is no flash of wrong color scheme on page load.
 */
export function ThemeScript() {
  const script = `(function(){try{var s=localStorage.getItem('${LS_KEY}');if(s==='light'||s==='dark')document.documentElement.setAttribute('data-theme',s);}catch(e){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
