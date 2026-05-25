/// <reference types="vite/client" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// SPA for the web_chat gateway platform.
//
// Build target: ``../gateway/web/_static/`` — the WebChatAdapter serves
// this directory under ``/static/*`` and the SPA shell under ``/``.
// (Stage 4A currently returns a placeholder HTML at ``/``; once this
// build runs, the placeholder is replaced by ``index.html`` from this
// directory in stage 7's gateway integration.)
//
// Dev server: ``:5173`` with ``/api/*`` proxied to the gateway's
// web_chat port (``:8643``).  Cookies pass through unchanged; the
// auth middleware on the server treats the Vite dev origin as the
// SPA origin.  SSE works through the proxy without extra config —
// the gateway sends ``Cache-Control: no-cache`` itself.

// import.meta.dirname is Node 20+ ESM-native, so we don't need
// @types/node or __dirname workarounds.
const projectRoot = new URL('.', import.meta.url).pathname

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: projectRoot + '../gateway/web/_static',
    emptyOutDir: true,
    sourcemap: true,
    // Single bundle keeps the SPA shell minimal — code-splitting
    // doesn't pay off for a ~5-route app and adds latency on cold
    // visits (extra HTTP requests under WSL/local dev).
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8643',
        changeOrigin: false,
      },
    },
  },
})
