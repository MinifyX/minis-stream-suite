export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  time: number;
  level: LogLevel;
  source: string;
  message: string;
}

const MAX_ENTRIES = 300;
const entries: LogEntry[] = [];

function format(part: unknown): string {
  if (part instanceof Error) return part.message;
  if (typeof part === 'string') return part;
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

/** Erstellt einen Logger. Alles landet in der Konsole und im Log der Übersicht. */
export function createLogger(source: string) {
  const write = (level: LogLevel, parts: unknown[]) => {
    const message = parts.map(format).join(' ');
    entries.push({ time: Date.now(), level, source, message });
    if (entries.length > MAX_ENTRIES) entries.shift();
    const out = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error;
    out(`[${source}] ${message}`);
  };
  return {
    info: (...parts: unknown[]) => write('info', parts),
    warn: (...parts: unknown[]) => write('warn', parts),
    error: (...parts: unknown[]) => write('error', parts),
  };
}

export type Logger = ReturnType<typeof createLogger>;

export function getLogs(): LogEntry[] {
  return entries.slice();
}
