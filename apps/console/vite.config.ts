import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The selfhost server serves dist/ at /, so asset URLs are relative to the page. `pnpm dev`
// sends /v1 to a server on 127.0.0.1:4400 (selfhost console, or the server's own dev script).
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/v1": "http://127.0.0.1:4400" } },
});
