import type { Plugin } from "vite";
import { defineConfig } from "vite";

// Pages builds set PAGES_BASE=/aletheia/ so assets resolve on
// https://hellenicdev.eu/aletheia/ and https://hellenicdev.github.io/aletheia/.
export default defineConfig({
  base: process.env.PAGES_BASE || "/",
  plugins: [preloadSansLatin()],
});

/** The landing heading uses IBM Plex Sans latin-400. Preload that file once its hash is known. */
function preloadSansLatin(): Plugin {
  let base = "/";
  return {
    name: "preload-sans-latin",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const file = Object.keys(ctx.bundle ?? {}).find(
          (name) => name.includes("ibm-plex-sans-latin-400") && name.endsWith(".woff2"),
        );
        if (!file) return html;
        const href = `${base}${file}`;
        const tag = `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin />`;
        return html.replace("</head>", `    ${tag}\n  </head>`);
      },
    },
  };
}
