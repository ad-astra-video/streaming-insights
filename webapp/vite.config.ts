import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy: route the control/server API (@streaming-insights/server, default
// :3100) and the media service (~:4070) through the Vite dev server so the
// browser talks to a single origin. Production builds serve the built bundle
// from the control server image, so these proxies matter only in `pnpm --filter
// @streaming-insights/webapp dev`.
const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:3100";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        // SSE must not be buffered by the proxy.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("Connection", "keep-alive");
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
