import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API = process.env.CODEJUDGE_API_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
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
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: { target: "es2022", sourcemap: false },
});
