/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    // The Kibitz widget asks /api/signal + /api/turn for the reliable self-hosted
    // signaling broker (signal.kibitz.chat) and TURN relay. Locally those endpoints
    // don't exist, so it falls back to the PUBLIC PeerJS broker — whose membership
    // sync is flaky (intermittent one-way roster → one peer can't see the other's
    // video). Proxy them to live kibitz.chat so dev uses the same reliable path as
    // production. (A deployed Whist needs its own /api functions or this proxy.)
    proxy: {
      '/api': { target: 'https://kibitz.chat', changeOrigin: true, secure: true },
    },
  },
  test: { include: ['src/**/*.test.ts'] },
})
