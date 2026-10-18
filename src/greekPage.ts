import { STRINGS } from "./i18n";

const EN_CANONICAL = "https://hellenicdev.eu/aletheia/";
const EL_CANONICAL = "https://hellenicdev.eu/aletheia/el/";

/** Static Greek document for link previews that do not run JavaScript. */
export function renderGreekDocument(html: string): string {
  const en = STRINGS.en;
  const el = STRINGS.el;
  return html
    .replace("<html lang=\"en\">", "<html lang=\"el\">")
    .replaceAll(en.metaTitle, el.metaTitle)
    .replaceAll(en.metaDescription, el.metaDescription)
    .replaceAll(en.imageAlt, el.imageAlt)
    .replace(
      `<link rel="canonical" href="${EN_CANONICAL}" />`,
      `<link rel="canonical" href="${EL_CANONICAL}" />`,
    )
    .replace(
      `<meta property="og:url" content="${EN_CANONICAL}" />`,
      `<meta property="og:url" content="${EL_CANONICAL}" />`,
    )
    .replace(
      `<meta property="og:locale" content="en_GB" />`,
      `<meta property="og:locale" content="el_GR" />`,
    )
    .replace(
      `<meta property="og:locale:alternate" content="el_GR" />`,
      `<meta property="og:locale:alternate" content="en_GB" />`,
    );
}
