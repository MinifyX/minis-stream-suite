/** Reine Logik des Watchtime-Addons: Bericht bauen und Codes aus dem Chat erkennen. */

export const INTERVAL_MINUTES = 5;
const MAX_QUEUE = 24;

export interface Report {
  id: string;
  viewers: { login: string; minutes: number }[];
  links: { login: string; code: string }[];
}

/** `!verknuepfen 123456` im Chat verknüpft das Twitch-Konto mit Discord. */
export function linkCode(message: string): string | null {
  return message.trim().match(/^!verknuepfen\s+(\d{6})$/i)?.[1] ?? null;
}

export function buildReport(id: string, logins: string[], links: Report['links']): Report {
  return { id, viewers: [...new Set(logins.map((l) => l.toLowerCase()))].map((login) => ({ login, minutes: INTERVAL_MINUTES })), links };
}

/** Nicht zugestellte Berichte bleiben begrenzt liegen. Die Empfängerseite verarbeitet jede ID nur einmal. */
export function enqueue(queue: Report[], report: Report): Report[] {
  return [...queue, report].slice(-MAX_QUEUE);
}

export function normalizeUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Nur http und https');
  return url.origin;
}
