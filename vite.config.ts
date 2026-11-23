import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Client + vendor portal — separate build so external users never download internal screens (ADR-004).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // /api → the Node backend, exactly like Nginx on the EC2 server (same origin: simple cookies, no CORS).
  server: { port: 5174, proxy: { '/api': { target: process.env.API_TARGET ?? 'http://localhost:4000', changeOrigin: false } } },
  preview: { port: 4174 },
  // Source maps off for public hosting (don't ship source); opt in with SOURCEMAP=true.
  build: { target: 'es2022', sourcemap: process.env.SOURCEMAP === 'true', assetsInlineLimit: 0 },
});
