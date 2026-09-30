import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      workbox: {
        // The SPA shell must NOT be served for server-rendered pages: the
        // login-link page (/api/auth/verify) and shared Files (/f/:id).
        navigateFallbackDenylist: [/^\/api\//, /^\/f\//, /\.html$/, /\.vcf$/],
        importScripts: ["push-sw.js"],
      },
      manifest: {
        name: "Family HQ",
        short_name: "Family HQ",
        description:
          "A family's operations hub — school, logistics, calendar, to-dos, and alerts.",
        theme_color: "#2563eb",
        background_color: "#f1f5f9",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
});
