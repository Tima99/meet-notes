import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The MeetNotes web panel: a static site (deployed to Vercel), no server code. */
export default defineConfig({
  root: resolve(import.meta.dirname, 'web'),
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist-web'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: { port: 5174, strictPort: true },
  preview: { port: 5174, strictPort: true },
});
