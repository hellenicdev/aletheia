import { defineConfig } from "vite";

// Pages builds set PAGES_BASE=/aletheia/ so assets resolve on
// https://hellenicdev.eu/aletheia/ and https://hellenicdev.github.io/aletheia/.
export default defineConfig({
  base: process.env.PAGES_BASE || "/",
});
