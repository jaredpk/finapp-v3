import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Served as a module of portal.elevrics.ai at /finance. The portal forwards
  // this prefix intact rather than stripping it, so Vite generates matching
  // asset URLs and the service worker gets a correct scope. The server strips
  // it again on the way in, keeping every route registered at root — which is
  // how machine callers (Plaid webhooks, MCP) still reach it unprefixed.
  // Locally that means http://localhost:5173/finance/, not /.
  base: '/finance/',

  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png'],
      // Scope and start_url must sit under the base, or the installed app
      // controls the wrong paths. An existing install from the old
      // finance.elevrics.ai origin will not migrate — it needs reinstalling.
      scope: '/finance/',
      manifest: {
        name: 'FinApp',
        short_name: 'FinApp',
        description: 'FinApp Mobile Optimized',
        scope: '/finance/',
        start_url: '/finance/',
        theme_color: '#ffffff',
        icons: [
          {
            src: 'favicon.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'favicon.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      }
    })
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
      "/auth": "http://localhost:3001",
      "/callback": "http://localhost:3001",
    },
  },
});
