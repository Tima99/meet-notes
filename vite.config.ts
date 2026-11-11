import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Main build: side panel (HTML + React) and the background service worker (ES module).
 * The content script is built separately (vite.content.config.ts) because Chrome
 * cannot load content scripts as ES modules — it must be a single classic script.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src'),
  publicDir: resolve(import.meta.dirname, 'public'),
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: false, // `npm run clean` handles this; the content build shares dist/
    sourcemap: true,
    target: 'chrome120',
    modulePreload: false,
    rolldownOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, 'src/sidepanel/index.html'),
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
