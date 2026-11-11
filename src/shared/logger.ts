/**
 * Minimal structured logger. Output goes to the local DevTools console only —
 * nothing is ever sent anywhere. Caption text must only be logged at `debug`.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogData = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(event: string, data?: LogData): void;
  info(event: string, data?: LogData): void;
  warn(event: string, data?: LogData): void;
  error(event: string, data?: LogData): void;
  child(scope: string): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = import.meta.env.DEV ? 'debug' : 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function serialize(data: LogData | undefined): LogData | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = value instanceof Error ? { name: value.name, message: value.message } : value;
  }
  return out;
}

export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel, event: string, data?: LogData): void => {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    const payload = serialize(data);
    const prefix = `[MeetNotes:${scope}] ${event}`;
    if (payload) console[level](prefix, payload);
    else console[level](prefix);
  };
  return {
    debug: (e, d) => emit('debug', e, d),
    info: (e, d) => emit('info', e, d),
    warn: (e, d) => emit('warn', e, d),
    error: (e, d) => emit('error', e, d),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}
