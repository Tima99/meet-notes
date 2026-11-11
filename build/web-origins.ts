/**
 * Build-time configuration for the MeetNotes web panel bridge.
 *
 * MEETNOTES_WEB_ORIGINS (in .env or the environment): comma-separated exact
 * origins of the web panel, e.g. "https://my-meetnotes.vercel.app".
 * Only these origins get the bridge script and may read transcripts.
 */
export const DEFAULT_WEB_ORIGINS = 'http://localhost:5174';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export function resolveWebOrigins(raw: string | undefined): string[] {
  const entries = (raw?.trim() ? raw : DEFAULT_WEB_ORIGINS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origins = entries.map((entry) => {
    if (entry.includes('*')) throw new Error(`MEETNOTES_WEB_ORIGINS: wildcards are not allowed ("${entry}")`);
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`MEETNOTES_WEB_ORIGINS: "${entry}" is not a valid URL`);
    }
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
    if (!secure) throw new Error(`MEETNOTES_WEB_ORIGINS: "${entry}" must use https (http only for localhost)`);
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`MEETNOTES_WEB_ORIGINS: "${entry}" must be an origin only, without a path`);
    }
    return url.origin;
  });
  return [...new Set(origins)];
}

/** Chrome match pattern for an origin (patterns without a port match any port). */
export function originToMatchPattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

export interface ManifestLike {
  content_scripts?: { matches: string[]; js: string[]; run_at?: string }[];
  [key: string]: unknown;
}

/** Adds the web-panel bridge content script to the base manifest. */
export function buildManifest(base: ManifestLike, origins: readonly string[]): ManifestLike {
  return {
    ...base,
    content_scripts: [
      ...(base.content_scripts ?? []),
      { matches: [...new Set(origins.map(originToMatchPattern))], js: ['web-bridge.js'], run_at: 'document_start' },
    ],
  };
}
