import { STRINGS } from "./i18n";

export const PRODUCTION_SITE = "https://hellenicdev.eu/aletheia/";
export const SHARE_IMAGE = "https://hellenicdev.eu/aletheia/og.png";

export type PageLang = "en" | "el";

/** Resolve the public base, including trailing slash, for canonical and hreflang URLs. */
export function siteBase(hostname: string, origin: string, appBase: string): string {
  if (hostname === "hellenicdev.eu" || hostname === "www.hellenicdev.eu") return PRODUCTION_SITE;
  const path = appBase.startsWith("/") ? appBase : `/${appBase}`;
  const normalized = path.endsWith("/") ? path : `${path}/`;
  return `${origin}${normalized}`;
}

export function appBaseFromPath(pathname: string): string {
  return pathname === "/aletheia" || pathname.startsWith("/aletheia/") ? "/aletheia/" : "/";
}

export function isGreekPath(pathname: string): boolean {
  return /\/el\/?$/.test(pathname);
}

export function pageLangFromSearch(
  search: string,
  stored: string | null,
  navigatorLang: string,
  pathname = "",
): PageLang {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const lang = params.get("lang");
  if (lang === "el" || lang === "en") return lang;
  if (isGreekPath(pathname)) return "el";
  const demo = params.get("demo");
  if (demo === "el") return "el";
  if (demo === "en" || demo === "1") return "en";
  if (stored === "el" || stored === "en") return stored;
  return navigatorLang.toLowerCase().startsWith("el") ? "el" : "en";
}

/** Keep `demo` and other params. Drop `lang`, which lives in the path. */
export function langSearch(currentSearch: string, lang: PageLang): string {
  const params = new URLSearchParams(currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch);
  params.delete("lang");
  if (lang === "en" && params.get("demo") === "el") params.set("demo", "1");
  const next = params.toString();
  return next ? `?${next}` : "";
}

/** Path-shaped URL for a language. `?lang=el` becomes `/el/`. */
export function languageUrl(pathname: string, search: string, lang: PageLang): string {
  const base = appBaseFromPath(pathname);
  const path = lang === "el" ? `${base}el/` : base;
  const query = langSearch(search, lang);
  return `${path}${query}`;
}

export function documentMeta(lang: PageLang, pageBase: string) {
  const copy = STRINGS[lang];
  const canonical = lang === "el" ? `${pageBase}el/` : pageBase;
  return {
    title: copy.metaTitle,
    description: copy.metaDescription,
    imageAlt: copy.imageAlt,
    locale: lang === "el" ? "el_GR" : "en_GB",
    canonical,
    alternates: {
      en: pageBase,
      el: `${pageBase}el/`,
      "x-default": pageBase,
    },
    image: SHARE_IMAGE,
  };
}
