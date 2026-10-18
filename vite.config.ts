import fs from "node:fs";
import path from "node:path";
import type { Connect, Plugin, ViteDevServer } from "vite";
import { defineConfig } from "vite";
import { renderGreekDocument } from "./src/greekPage";

// Pages builds set PAGES_BASE=/aletheia/ so assets resolve on
// https://hellenicdev.eu/aletheia/ and https://hellenicdev.github.io/aletheia/.
export default defineConfig({
  base: process.env.PAGES_BASE || "/",
  plugins: [preloadSansLatin(), greekPages()],
});

/** Emit /el/index.html and serve it in dev so Greek link previews do not need JavaScript. */
function greekPages(): Plugin {
  const respond = async (
    server: ViteDevServer,
    req: Connect.IncomingMessage,
    res: Connect.ServerResponse,
    next: Connect.NextFunction,
  ) => {
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    if (!/\/el\/?$/.test(pathname)) return next();
    try {
      const index = fs.readFileSync(path.resolve("index.html"), "utf8");
      const transformed = await server.transformIndexHtml(req.url ?? "/el/", index);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(renderGreekDocument(transformed));
    } catch (error) {
      next(error);
    }
  };
  return {
    name: "greek-pages",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void respond(server, req, res, next);
      });
    },
    writeBundle(options) {
      const dir = options.dir;
      if (!dir) return;
      const source = fs.readFileSync(path.join(dir, "index.html"), "utf8");
      const folder = path.join(dir, "el");
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "index.html"), renderGreekDocument(source));
    },
  };
}

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
