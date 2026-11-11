import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/** Content script build: one self-contained IIFE, no imports, no chunks. */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: false,
    sourcemap: true,
    target: 'chrome120',
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'MeetNotesContent',
      fileName: () => 'content.js',
    },
  },
});
