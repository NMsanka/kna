import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The application is served by the API, not by a second process.
 *
 * `base: '/assets/'` keeps the built files under one prefix the API can serve statically, so
 * every other path can fall through to the single-page shell without a rule per route.
 *
 * In development the Vite server proxies the API rather than the other way round, so there is
 * no CORS to configure and the session cookie is same-origin exactly as it is in production.
 */
export default defineConfig({
  plugins: [react()],
  base: '/assets/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No hashed chunks for a page this small: one JS file and one CSS file are easier to serve,
    // easier to cache-bust by hand, and easier to reason about than a manifest.
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'app-[name].js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/app/api': 'http://localhost:8080',
    },
  },
});
