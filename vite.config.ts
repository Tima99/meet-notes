import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buildManifest, resolveWebOrigins, type ManifestLike } from './build/web-origins';

const root = import.meta.dirname;

/** Emits dist/manifest.json = manifest.base.json + the web-panel bridge for the configured origins. */
function manifestPlugin(origins: readonly string[]): Plugin {
  return {
    name: 'meetnotes-manifest',
    generateBundle() {
      const base = JSON.parse(readFileSync(resolve(root, 'manifest.base.json'), 'utf8')) as ManifestLike;
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(buildManifest(base, origins), null, 2)}\n` });
    },
  };
}

/**
 * Main extension build: side panel (HTML + React) and the background service worker.
 * Content scripts are built separately (vite.content.config.ts) as classic scripts.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  const origins = resolveWebOrigins(env['MEETNOTES_WEB_ORIGINS']);
  return {
    root: resolve(root, 'src'),
    publicDir: false,
    plugins: [react(), manifestPlugin(origins)],
    define: { __MEETNOTES_WEB_ORIGINS__: JSON.stringify(origins) },
    build: {
      outDir: resolve(root, 'dist'),
      emptyOutDir: false, // `npm run clean` handles this; content builds share dist/
      sourcemap: true,
      target: 'chrome120',
      modulePreload: false,
      rolldownOptions: {
        input: {
          sidepanel: resolve(root, 'src/sidepanel/index.html'),
          background: resolve(root, 'src/background/index.ts'),
        },
        output: {
          entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        },
      },
    },
  };
});
