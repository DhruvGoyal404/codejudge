import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API = process.env.CODEJUDGE_API_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "localhost", // browser-facing dev origin: http://localhost:5173 (must match the OAuth callback)
    port: 5173,
    strictPort: true,
    // Same-origin in dev: /api/* -> Express (no CORS). SSE responses are
    // streamed through unbuffered (verified in docs/PHASE4.md).
    proxy: {
      "/api": {
        target: API,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  preview: { host: "localhost", port: 4173, strictPort: true },
  build: { target: "es2022", sourcemap: false },
});
