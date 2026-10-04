import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { compactPretextPlugin } from "../../scripts/compact-pretext.js";
import { name as hubName } from "./app.json";

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [compactPretextPlugin(), {
    name: "pilot-page-title",
    transformIndexHtml: html => html.replace(/<title>[^<]*<\/title>/,
      `<title>${mode === "hub" ? hubName : "Even-Pilot"} · Agents, in sight</title>`),
  }],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
}));
