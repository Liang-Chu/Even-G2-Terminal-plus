import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { compactPretextPlugin } from "../../scripts/compact-pretext.js";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [compactPretextPlugin()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
