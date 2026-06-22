import { create } from "zustand";
import { en } from "@/locales/en";

/** Every translatable key — derived from the English source so a typo fails to compile. */
export type TKey = keyof typeof en;
/** A non-English catalog: any subset of keys; missing ones fall back to English. */
export type Catalog = Partial<Record<TKey, string>>;

/** Add a language here + a catalog file and it appears in the picker — nothing else to wire. */
export const LANGUAGES = [
  { id: "en", label: "English", native: "English" },
  { id: "de", label: "German", native: "Deutsch" },
  { id: "es", label: "Spanish", native: "Español" },
  { id: "fr", label: "French", native: "Français" },
] as const;
export type Lang = (typeof LANGUAGES)[number]["id"];

const LS = "wavrplay-lang";

// Only English ships in the main bundle (it's the type source + universal fallback). The other catalogs
// are ~33 KB EACH — loading all four at launch bloated the startup parse for strings most users never see.
// They're code-split + fetched on demand (and cached) the first time their language is active. [launch perf]
const cache: Partial<Record<Lang, Catalog>> = { en };
const loaders: Record<Exclude<Lang, "en">, () => Promise<Catalog>> = {
  de: () => import("@/locales/de").then((m) => m.de),
  es: () => import("@/locales/es").then((m) => m.es),
  fr: () => import("@/locales/fr").then((m) => m.fr),
};

function detect(): Lang {
  try {
    const saved = localStorage.getItem(LS);
    if (saved && (saved === "en" || saved in loaders)) return saved as Lang;
  } catch { /* ignore */ }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "en").slice(0, 2);
  return (nav === "en" || nav in loaders ? nav : "en") as Lang;
}

interface I18nState {
  lang: Lang;
  /** Bumped when an async catalog finishes loading, so `useT` re-renders with the real strings. */
  rev: number;
  setLang: (l: Lang) => void;
}
export const useI18n = create<I18nState>((set) => ({
  lang: detect(),
  rev: 0,
  setLang: (lang) => {
    try { localStorage.setItem(LS, lang); } catch { /* ignore */ }
    if (typeof document !== "undefined") document.documentElement.lang = lang;
    set({ lang });
    ensureCatalog(lang);
  },
}));

/** Fetch (once) the catalog for a language; English is already in-bundle. Bumps `rev` on arrival. */
function ensureCatalog(lang: Lang) {
  if (lang === "en" || cache[lang]) return;
  loaders[lang]?.().then((cat) => {
    cache[lang] = cat;
    if (useI18n.getState().lang === lang) useI18n.setState((s) => ({ rev: s.rev + 1 }));
  }).catch(() => { /* keep English fallback */ });
}
// Kick off the initially-detected language right away (no-op for English).
ensureCatalog(useI18n.getState().lang);

/** Resolve a key for a language: lang → English → the key itself. Supports {var} interpolation.
 *  Falls back to English until the (lazily-loaded) catalog has arrived. */
export function translate(lang: Lang, key: TKey, vars?: Record<string, string | number>): string {
  let s = cache[lang]?.[key] ?? en[key] ?? key;
  if (vars) for (const k in vars) s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(vars[k]));
  return s;
}

/** Hook used in components — re-renders when the language changes OR its catalog finishes loading. */
export function useT() {
  const lang = useI18n((s) => s.lang);
  useI18n((s) => s.rev); // subscribe so a late-arriving catalog triggers a re-render
  return (key: TKey, vars?: Record<string, string | number>) => translate(lang, key, vars);
}
