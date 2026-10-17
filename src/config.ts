/**
 * Backend URL
 * -----------
 * This is the one place the static site learns where the Worker lives.
 * Point it at your deployed worker before building for GitHub Pages.
 *
 * Local `wrangler dev` serves the API at http://127.0.0.1:8787.
 * Example production value: "https://aletheia.<your-subdomain>.workers.dev"
 */
export const BACKEND_URL = "http://127.0.0.1:8787";
