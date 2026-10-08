import { HttpError } from '../../core/server';
import { ROLE_LEVEL, parseRole, type Role } from '../../core/chat';
import type { QueueItem } from './sets';

/**
 * Songwünsche: Regeln ohne Twitch/Spotify (testbar).
 * Wer darf wünschen, was landet direkt in der Queue, was als Vorschlag, welche Limits gelten.
 */

export interface RequestMessages {
  queued: string;
  suggested: string;
  approved: string;
  rejected: string;
  notFound: string;
  denied: string;
  song: string;
  nothing: string;
  removed: string;
  queueList: string;
  queueEmpty: string;
}

export interface RequestSettings {
  enabled: boolean;
  /** Chat-Command inkl. Präfix, z.B. "!sr" */
  command: string;
  /** Wer überhaupt per Chat wünschen darf */
  whoCanRequest: Role;
  /** Ab dieser Rolle landen Chat-Wünsche direkt in der Queue, darunter als Vorschlag */
  directRole: Role;
  /** Kanalpunkte-Belohnung der Suite ("" = keine) */
  rewardId: string;
  /** Name und Kosten der Belohnung (zum Anzeigen/Ändern) */
  rewardTitle: string;
  rewardCost: number;
  /** Wünsche per Kanalpunkte direkt in die Queue (sonst Vorschlag) */
  rewardDirect: boolean;
  /** Wo gesucht wird: auto = passend zur gerade laufenden Quelle */
  source: 'auto' | 'spotify' | 'local';
  /** Höchstens so viele offene Wünsche (Vorschlag + Queue) pro Zuschauer */
  maxPerUser: number;
  maxQueue: number;
  /** Längster erlaubter Titel in Sekunden (0 = egal). Gilt nur, wenn die Länge bekannt ist. */
  maxDurationSec: number;
  /** Wartezeit zwischen zwei Wünschen eines Zuschauers (Sekunden) */
  userCooldownSec: number;
  allowExplicit: boolean;
  /** Wörter/Artists, die nicht gewünscht werden dürfen (Titel oder Artist enthält das Wort) */
  blocklist: string[];
  /** Chat-Antworten schicken */
  reply: boolean;
  messages: RequestMessages;
}

export const REQUEST_DEFAULTS: RequestSettings = {
  enabled: false,
  command: '!sr',
  whoCanRequest: 'everyone',
  directRole: 'vip',
  rewardId: '',
  rewardTitle: 'Song wünschen',
  rewardCost: 500,
  rewardDirect: true,
  source: 'auto',
  maxPerUser: 2,
  maxQueue: 25,
  maxDurationSec: 480,
  userCooldownSec: 60,
  allowExplicit: true,
  blocklist: [],
  reply: true,
  messages: {
    queued: '@{user} 🎵 „{title}“ von {artist} ist in der Queue (Platz {pos}).',
    suggested: '@{user} 📝 „{title}“ von {artist} ist vorgeschlagen und wartet auf Freigabe.',
    approved: '@{user} ✅ Dein Wunsch „{title}“ ist jetzt in der Queue (Platz {pos}).',
    rejected: '@{user} ❌ Dein Wunsch „{title}“ wurde abgelehnt.',
    notFound: '@{user} Dazu habe ich keinen Song gefunden 🤷',
    denied: '@{user} {reason}',
    song: '🎵 Gerade läuft: „{title}“ von {artist}{requested}',
    nothing: 'Gerade läuft keine Musik.',
    removed: '@{user} „{title}“ ist wieder raus.',
    queueList: '🎶 Als Nächstes: {list}',
    queueEmpty: 'Die Song-Queue ist leer.',
  },
};

export type RequestCommand = 'request' | 'song' | 'wrongsong' | 'queue' | 'skip';

export type RequestStatus = 'pending' | 'queued' | 'playing' | 'played' | 'rejected' | 'removed';

export interface SongRequest {
  id: string;
  query: string;
  item: QueueItem;
  user: { id: string; name: string };
  source: 'chat' | 'reward' | 'panel';
  redemption: { id: string; rewardId: string } | null;
  status: RequestStatus;
  at: number;
}

/** Chat-Nachricht → Befehl + Text dahinter (oder null) */
export function parseRequestCommand(message: string, settings: RequestSettings): { command: RequestCommand; arg: string } | null {
  const text = message.trim();
  const [first = '', ...rest] = text.split(/\s+/);
  const word = first.toLowerCase();
  const arg = rest.join(' ').trim();
  if (word === settings.command.toLowerCase() || word === '!songrequest') return { command: 'request', arg };
  if (word === '!song' || word === '!currentsong') return { command: 'song', arg };
  if (word === '!wrongsong') return { command: 'wrongsong', arg };
  if (word === '!queue' || word === '!songqueue') return { command: 'queue', arg };
  if (word === '!skip' || word === '!skipsong') return { command: 'skip', arg };
  return null;
}

/** Direkt in die Queue, als Vorschlag oder gar nicht? */
export function requestMode(level: number, source: 'chat' | 'reward', settings: RequestSettings): 'direct' | 'suggest' | 'denied' {
  if (source === 'reward') return settings.rewardDirect ? 'direct' : 'suggest';
  if (level < ROLE_LEVEL[settings.whoCanRequest]) return 'denied';
  return level >= ROLE_LEVEL[settings.directRole] ? 'direct' : 'suggest';
}

export interface LimitContext {
  item: QueueItem & { explicit?: boolean };
  userId: string;
  /** Mods/Broadcaster sind von Limits ausgenommen */
  privileged: boolean;
  /** Offene Wünsche (pending + queued) */
  open: SongRequest[];
  /** Zeitpunkt des letzten Wunsches dieses Zuschauers (oder 0) */
  lastAt: number;
  now: number;
  settings: RequestSettings;
}

/** Gibt den Grund zurück, warum der Wunsch nicht geht – oder null */
export function checkLimits(c: LimitContext): string | null {
  const { item, settings } = c;
  const haystack = `${item.title} ${item.artists.join(' ')}`.toLowerCase();
  const blocked = settings.blocklist.find((w) => w.trim() && haystack.includes(w.trim().toLowerCase()));
  if (blocked) return 'Dieser Song steht auf der Sperrliste.';
  if (!settings.allowExplicit && item.explicit) return 'Explizite Songs sind gerade nicht erlaubt.';
  if (settings.maxDurationSec > 0 && item.durationMs > settings.maxDurationSec * 1000) {
    return `Der Song ist zu lang (max. ${Math.floor(settings.maxDurationSec / 60)}:${String(settings.maxDurationSec % 60).padStart(2, '0')} Min.).`;
  }
  if (c.open.some((r) => r.item.kind === item.kind && r.item.ref === item.ref)) return 'Der Song ist schon gewünscht.';
  if (c.privileged) return null;
  if (c.open.filter((r) => r.status === 'queued').length >= settings.maxQueue) return 'Die Queue ist gerade voll.';
  if (c.open.filter((r) => r.user.id === c.userId).length >= settings.maxPerUser) {
    return `Du hast schon ${settings.maxPerUser} offene Wünsche.`;
  }
  const wait = c.lastAt + settings.userCooldownSec * 1000 - c.now;
  if (wait > 0) return `Bitte noch ${Math.ceil(wait / 1000)} s warten.`;
  return null;
}

/** {user}, {title}, {artist}, {pos} … einsetzen */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all)).trim();
}

export interface SearchableTrack {
  file: string;
  title: string;
  artists: string[];
  album: string | null;
}

const normalize = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Eigene Musik durchsuchen: Alle Wörter der Suche müssen in Titel/Artist/Album/Dateiname vorkommen.
 * Treffer im Titel zählen mehr. Gibt die besten Treffer zurück.
 */
export function searchLocal<T extends SearchableTrack>(tracks: T[], query: string, limit = 5): T[] {
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const scored: Array<{ track: T; score: number }> = [];
  for (const track of tracks) {
    const title = normalize(track.title);
    const all = `${title} ${normalize(track.artists.join(' '))} ${normalize(track.album ?? '')} ${normalize(track.file)}`;
    if (!words.every((w) => all.includes(w))) continue;
    let score = words.filter((w) => title.includes(w)).length * 2;
    if (title === normalize(query)) score += 10;
    scored.push({ track, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.track);
}

const str = (value: unknown, max = 300) => String(value ?? '').trim().slice(0, max);
const num = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

export function mergeRequestSettings(current: RequestSettings, input: unknown): RequestSettings {
  const p = (input ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const next = structuredClone(current);
  if (typeof p.enabled === 'boolean') next.enabled = p.enabled;
  if (p.command !== undefined) {
    let cmd = str(p.command, 30).toLowerCase().split(/\s+/)[0] ?? '';
    if (cmd && /^[\p{L}\p{N}]/u.test(cmd)) cmd = `!${cmd}`;
    if (!/^[!?#.$%&~][\p{L}\p{N}_-]{1,25}$/u.test(cmd)) throw new HttpError(400, 'Der Command braucht ein Präfix und einen Namen, z.B. !sr.');
    next.command = cmd;
  }
  if (p.whoCanRequest !== undefined) next.whoCanRequest = parseRole(p.whoCanRequest);
  if (p.directRole !== undefined) next.directRole = parseRole(p.directRole, 'vip');
  if (typeof p.rewardDirect === 'boolean') next.rewardDirect = p.rewardDirect;
  if (['auto', 'spotify', 'local'].includes(p.source)) next.source = p.source;
  if (p.maxPerUser !== undefined) next.maxPerUser = num(p.maxPerUser, 1, 50, 2);
  if (p.maxQueue !== undefined) next.maxQueue = num(p.maxQueue, 1, 200, 25);
  if (p.maxDurationSec !== undefined) next.maxDurationSec = num(p.maxDurationSec, 0, 3600, 480);
  if (p.userCooldownSec !== undefined) next.userCooldownSec = num(p.userCooldownSec, 0, 3600, 60);
  if (typeof p.allowExplicit === 'boolean') next.allowExplicit = p.allowExplicit;
  if (typeof p.reply === 'boolean') next.reply = p.reply;
  if (p.blocklist !== undefined) {
    const list = Array.isArray(p.blocklist) ? p.blocklist : String(p.blocklist).split(/[\n,]/);
    next.blocklist = list.map((w: unknown) => str(w, 60)).filter(Boolean).slice(0, 200);
  }
  if (p.messages && typeof p.messages === 'object') {
    for (const key of Object.keys(REQUEST_DEFAULTS.messages) as (keyof RequestMessages)[]) {
      if (p.messages[key] !== undefined) next.messages[key] = str(p.messages[key], 400) || REQUEST_DEFAULTS.messages[key];
    }
  }
  return next;
}
